/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import Bluebird from "bluebird"
import { cloneDeep, partition, set, uniq } from "lodash"
import { LogEntry } from "../../../logger/log-entry"
import { NamespaceStatus } from "../../../plugin/base"
import { ModuleAndRuntimeActionHandlers } from "../../../plugin/plugin"
import { DeleteServiceParams } from "../../../types/plugin/service/deleteService"
import { DeployServiceParams } from "../../../types/plugin/service/deployService"
import { GetServiceLogsParams } from "../../../types/plugin/service/getServiceLogs"
import { GetServiceStatusParams } from "../../../types/plugin/service/getServiceStatus"
import { ServiceStatus } from "../../../types/service"
import { gardenAnnotationKey } from "../../../util/string"
import { KubeApi } from "../api"
import { KubernetesPluginContext, ServiceResourceSpec } from "../config"
import { configureDevMode, KubernetesDeployDevModeSyncSpec, startDevModeSync } from "../dev-mode"
import { HelmService } from "../helm/moduleConfig"
import { apply, deleteObjectsBySelector, KUBECTL_DEFAULT_TIMEOUT } from "../kubectl"
import { streamK8sLogs } from "../logs"
import { getActionNamespace, getActionNamespaceStatus } from "../namespace"
import { getForwardablePorts, getPortForwardHandler, killPortForwards } from "../port-forward"
import { getK8sIngresses } from "../status/ingress"
import {
  compareDeployedResources,
  isConfiguredForDevMode,
  isConfiguredForLocalMode,
  waitForResources,
} from "../status/status"
import { getTaskResult } from "../task-results"
import { getTestResult } from "../test-results"
import { BaseResource, KubernetesResource, KubernetesServerResource, SyncableResource } from "../types"
import { getServiceResource, getServiceResourceSpec } from "../util"
import { convertServiceResource, gardenNamespaceAnnotationValue, getManifests } from "./common"
import { configureKubernetesModule, KubernetesModule, KubernetesService } from "./moduleConfig"
import { execInKubernetesService } from "./exec"
import { runKubernetesTask } from "./run"
import { testKubernetesModule } from "./test"
import { configureLocalMode, startServiceInLocalMode } from "../local-mode"
import { ExecBuildConfig } from "../../exec/config"
import { KubernetesActionConfig, KubernetesDeployActionConfig } from "./config"

export const kubernetesHandlers: Partial<ModuleAndRuntimeActionHandlers<KubernetesModule>> = {
  configure: configureKubernetesModule,

  convert: async (params) => {
    const { module, services, dummyBuild, convertBuildDependency, prepareRuntimeDependencies } = params
    const actions: (ExecBuildConfig | KubernetesActionConfig)[] = []

    if (dummyBuild) {
      actions.push(dummyBuild)
    }

    const syncs: KubernetesDeployDevModeSyncSpec[] = []
    const service = services[0] // There's always exactly one service on kubernetes modules

    const serviceResource = module.spec.serviceResource

    if (module.spec.devMode) {
      const target = convertServiceResource(module, serviceResource)

      if (target) {
        syncs.push({
          sourcePath: service.sourceModule.path,
          target,
        })
      }
    }

    const deployAction: KubernetesDeployActionConfig = {
      kind: "Deploy",
      type: "kubernetes",
      name: module.name,
      ...params.baseFields,

      build: dummyBuild?.name,
      dependencies: prepareRuntimeDependencies(module.spec.dependencies, dummyBuild),

      include: module.spec.files,

      spec: {
        ...module.spec,

        devMode: {
          syncs,
        },
      },
    }

    if (serviceResource?.containerModule) {
      const build = convertBuildDependency(serviceResource.containerModule)

      // TODO-G2: make this implicit
      deployAction.dependencies?.push(build)
    }

    actions.push(deployAction)

    for (const task of module.testConfigs) {
      const target = convertServiceResource(module, task.spec.resource)

      if (!target) {
        continue
      }

      actions.push({
        kind: "Run",
        type: "kubernetes",
        name: module.name,
        ...params.baseFields,
        disabled: task.disabled,

        build: dummyBuild?.name,
        dependencies: prepareRuntimeDependencies(task.dependencies, dummyBuild),

        spec: {
          ...task.spec,
          target,
        },
      })
    }

    for (const test of module.testConfigs) {
      const target = convertServiceResource(module, test.spec.resource)

      if (!target) {
        continue
      }

      actions.push({
        kind: "Test",
        type: "kubernetes",
        name: module.name + "-" + test.name,
        ...params.baseFields,
        disabled: test.disabled,

        build: dummyBuild?.name,
        dependencies: prepareRuntimeDependencies(test.dependencies, dummyBuild),

        spec: {
          ...test.spec,
          target,
        },
      })
    }

    return {
      group: {
        kind: "Group",
        name: module.name,
        actions,
        variables: module.variables,
        varfiles: module.varfile ? [module.varfile] : undefined,
      },
    }
  },

  deleteService,
  execInService: execInKubernetesService,
  deployService: deployKubernetesService,
  getPortForward: getPortForwardHandler,
  getServiceLogs,
  getServiceStatus: getKubernetesServiceStatus,
  getTaskResult,
  getTestResult,
  runTask: runKubernetesTask,
  testModule: testKubernetesModule,
}

interface KubernetesStatusDetail {
  remoteResources: KubernetesServerResource[]
}

export type KubernetesServiceStatus = ServiceStatus<KubernetesStatusDetail>

export async function getKubernetesServiceStatus({
  ctx,
  module,
  log,
  service,
  devMode,
  localMode,
}: GetServiceStatusParams<KubernetesModule>): Promise<KubernetesServiceStatus> {
  const k8sCtx = <KubernetesPluginContext>ctx
  const namespaceStatus = await getActionNamespaceStatus({
    ctx: k8sCtx,
    log,
    module,
    provider: k8sCtx.provider,
    skipCreate: true,
  })
  const namespace = namespaceStatus.namespaceName
  const api = await KubeApi.factory(log, ctx, k8sCtx.provider)
  // FIXME: We're currently reading the manifests from the module source dir (instead of build dir)
  // because the build may not have been staged.
  // This means that manifests added via the `build.dependencies[].copy` field will not be included.
  const manifests = await getManifests({ ctx, api, log, module, defaultNamespace: namespace, readFromSrcDir: true })
  const prepareResult = await configureSpecialModesForManifests({
    ctx: k8sCtx,
    log,
    module,
    service,
    devMode,
    localMode,
    manifests,
  })

  let { state, remoteResources, deployedWithDevMode, deployedWithLocalMode } = await compareDeployedResources(
    k8sCtx,
    api,
    namespace,
    prepareResult.manifests,
    log
  )

  // Local mode has its own port-forwarding configuration
  const forwardablePorts = deployedWithLocalMode ? [] : getForwardablePorts(remoteResources, service)

  if (state === "ready") {
    // Local mode always takes precedence over dev mode
    if (localMode && service.spec.localMode) {
      const serviceResourceSpec = getServiceResourceSpec(module, undefined)
      const target = await getServiceResource({
        ctx: k8sCtx,
        log,
        provider: k8sCtx.provider,
        module,
        manifests: remoteResources,
        resourceSpec: serviceResourceSpec,
      })

      if (!isConfiguredForLocalMode(target)) {
        state = "outdated"
      }
    } else if (devMode && service.spec.devMode) {
      // Need to start the dev-mode sync here, since the deployment handler won't be called.
      const serviceResourceSpec = getServiceResourceSpec(module, undefined)
      const target = await getServiceResource({
        ctx: k8sCtx,
        log,
        provider: k8sCtx.provider,
        module,
        manifests: remoteResources,
        resourceSpec: serviceResourceSpec,
        basePath: service.sourceModule.path,
        namespace,
        target,
        spec: service.spec.devMode,
        containerName: service.spec.devMode.containerName,
        deployName: service.name,
      })

      if (isConfiguredForDevMode(target)) {
        await startDevModeSync({
          ctx,
          log,
          moduleRoot: service.sourceModule.path,
          namespace,
          target,
          spec: service.spec.devMode,
          containerName: service.spec.devMode.containerName,
          serviceName: service.name,
        })
      } else {
        state = "outdated"
      }
    }
  }

  return {
    forwardablePorts,
    state,
    version: state === "ready" ? service.version : undefined,
    detail: { remoteResources },
    devMode: deployedWithDevMode,
    localMode: deployedWithLocalMode,
    namespaceStatuses: [namespaceStatus],
    ingresses: getK8sIngresses(remoteResources),
  }
}

export async function deployKubernetesService(
  params: DeployServiceParams<KubernetesModule>
): Promise<KubernetesServiceStatus> {
  const { ctx, module, service, log, devMode, localMode } = params

  const k8sCtx = <KubernetesPluginContext>ctx
  const provider = k8sCtx.provider
  const api = await KubeApi.factory(log, ctx, provider)

  const namespaceStatus = await getActionNamespaceStatus({
    ctx: k8sCtx,
    log,
    module,
    provider,
  })
  const namespace = namespaceStatus.namespaceName

  const manifests = await getManifests({ ctx, api, log, module, defaultNamespace: namespace })

  // We separate out manifests for namespace resources, since we don't want to apply a prune selector
  // when applying them.
  const [namespaceManifests, otherManifests] = partition(manifests, (m) => m.kind === "Namespace")

  if (namespaceManifests.length > 0) {
    // Don't prune namespaces
    await apply({ log, ctx, api, provider, manifests: namespaceManifests })
    await waitForResources({
      namespace,
      ctx,
      provider,
      actionName: service.name,
      resources: namespaceManifests,
      log,
      timeoutSec: service.spec.timeout || KUBECTL_DEFAULT_TIMEOUT,
    })
  }

  let target: SyncableResource | undefined

  const pruneLabels = { [gardenAnnotationKey("service")]: service.name }
  if (otherManifests.length > 0) {
    const prepareResult = await configureSpecialModesForManifests({
      ctx: k8sCtx,
      log,
      module,
      service,
      devMode,
      localMode,
      manifests,
    })

    target = prepareResult.target

    await apply({ log, ctx, api, provider: k8sCtx.provider, manifests: prepareResult.manifests, pruneLabels })
    await waitForResources({
      namespace,
      ctx,
      provider,
      actionName: service.name,
      resources: prepareResult.manifests,
      log,
      timeoutSec: service.spec.timeout || KUBECTL_DEFAULT_TIMEOUT,
    })
  }

  const status = await getKubernetesServiceStatus(params)

  // Make sure port forwards work after redeployment
  killPortForwards(service, status.forwardablePorts || [], log)

  if (target) {
    // Local mode always takes precedence over dev mode
    if (localMode && service.spec.localMode) {
      await startServiceInLocalMode({
        ctx,
        spec: service.spec.localMode,
        targetResource: target,
        gardenService: service,
        namespace,
        log,
        containerName: service.spec.localMode.containerName,
      })
    } else if (devMode && service.spec.devMode) {
      await startDevModeSync({
        ctx,
        log,
        basePath: service.sourceModule.path,
        namespace,
        target,
        spec: service.spec.devMode,
        containerName: service.spec.devMode.containerName,
        deployName: service.name,
      })
    }
  }

  const namespaceStatuses = [namespaceStatus]

  if (namespaceManifests.length > 0) {
    namespaceStatuses.push(
      ...namespaceManifests.map(
        (m) =>
          ({
            pluginName: provider.name,
            namespaceName: m.metadata.name,
            state: "ready",
          } as NamespaceStatus)
      )
    )
  }

  return {
    ...status,
    namespaceStatuses,
  }
}

async function deleteService(params: DeleteServiceParams): Promise<KubernetesServiceStatus> {
  const { ctx, log, service, module } = params
  const k8sCtx = <KubernetesPluginContext>ctx
  const namespace = await getActionNamespace({
    ctx: k8sCtx,
    log,
    module,
    provider: k8sCtx.provider,
  })
  const provider = k8sCtx.provider
  const api = await KubeApi.factory(log, ctx, provider)
  const manifests = await getManifests({ ctx, api, log, module, defaultNamespace: namespace })

  /**
   * We separate out manifests for namespace resources, since we need to delete each of them by name.
   *
   * Unlike other resources, Garden annotates namespace resources with their name - see `getManifests` for a discussion
   * of this.
   */
  const [namespaceManifests, otherManifests] = partition(manifests, (m) => m.kind === "Namespace")

  if (namespaceManifests.length > 0) {
    await Bluebird.map(namespaceManifests, (ns) => {
      const selector = `${gardenAnnotationKey("service")}=${gardenNamespaceAnnotationValue(ns.metadata.name)}`
      return deleteObjectsBySelector({
        log,
        ctx,
        provider,
        namespace,
        selector,
        objectTypes: ["Namespace"],
        includeUninitialized: false,
      })
    })
  }
  if (otherManifests.length > 0) {
    await deleteObjectsBySelector({
      log,
      ctx,
      provider,
      namespace,
      selector: `${gardenAnnotationKey("service")}=${service.name}`,
      objectTypes: uniq(manifests.map((m) => m.kind)),
      includeUninitialized: false,
    })
  }

  const status: KubernetesServiceStatus = { state: "missing", detail: { remoteResources: [] } }

  if (namespaceManifests.length > 0) {
    status.namespaceStatuses = namespaceManifests.map((m) => ({
      namespaceName: m.metadata.name,
      state: "missing",
      pluginName: provider.name,
    }))
  }

  return status
}

async function getServiceLogs(params: GetServiceLogsParams<KubernetesModule>) {
  const { ctx, log, module } = params
  const k8sCtx = <KubernetesPluginContext>ctx
  const provider = k8sCtx.provider
  const namespace = await getActionNamespace({
    ctx: k8sCtx,
    log,
    module,
    provider: k8sCtx.provider,
  })
  const api = await KubeApi.factory(log, ctx, provider)
  const manifests = await getManifests({ ctx, api, log, module, defaultNamespace: namespace })

  return streamK8sLogs({ ...params, provider, defaultNamespace: namespace, resources: manifests })
}

/**
 * Looks for a dev-mode or local-mode target in a list of manifests.
 * If found, the target is either configured for dev-mode/local-mode
 * or annotated with `dev-mode: false`, or `local-mode: false`.
 *
 * Returns the manifests with the original resource replaced by the modified spec.
 *
 * No-op if no target is found and neither dev-mode nor local-mode is enabled.
 */
async function configureSpecialModesForManifests({
  ctx,
  log,
  module,
  service,
  devMode,
  localMode,
  manifests,
}: {
  ctx: KubernetesPluginContext
  service: KubernetesService | HelmService
  log: LogEntry
  module: KubernetesModule
  devMode: boolean
  localMode: boolean
  manifests: KubernetesResource<BaseResource>[]
}) {
  const devModeSpec = service.spec.devMode
  const localModeSpec = service.spec.localMode

  let target: SyncableResource
  let resourceSpec: ServiceResourceSpec
  try {
    resourceSpec = getServiceResourceSpec(module, undefined)

    target = cloneDeep(
      await getServiceResource({
        ctx,
        log,
        provider: ctx.provider,
        module,
        manifests,
        resourceSpec,
      })
    )
  } catch (err) {
    const enableLocalMode = localMode && localModeSpec
    const enableDevMode = devMode && devModeSpec
    // This is only an error if we're actually trying to start dev or local mode.
    if (enableDevMode || enableLocalMode) {
      throw err
    } else {
      // Nothing to do, so we return the original manifests
      return { manifests, target: undefined }
    }
  }

  set(target, ["metadata", "annotations", gardenAnnotationKey("dev-mode")], "false")
  set(target, ["metadata", "annotations", gardenAnnotationKey("local-mode")], "false")

  // Local mode always takes precedence over dev mode
  if (localMode && localModeSpec) {
    // The "local-mode" annotation is set in `configureLocalMode`.
    await configureLocalMode({
      ctx,
      spec: localModeSpec,
      targetResource: target,
      gardenService: service,
      log,
      containerName: localModeSpec.containerName,
    })
  } else if (devMode && devModeSpec) {
    // The "dev-mode" annotation is set in `configureDevMode`.
    configureDevMode({
      target,
      spec: devModeSpec,
      containerName: devModeSpec.containerName,
    })
  }

  // Replace the original resource with the modified spec
  const preparedManifests = manifests
    .filter((m) => !(m.kind === target!.kind && target?.metadata.name === m.metadata.name))
    .concat(<KubernetesResource<BaseResource>>target)

  return { target, manifests: preparedManifests }
}
