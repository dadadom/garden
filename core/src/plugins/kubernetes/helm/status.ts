/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { ForwardablePort, ServiceIngress, ServiceState, ServiceStatus } from "../../../types/service"
import { LogEntry } from "../../../logger/log-entry"
import { helm } from "./helm-cli"
import { getReleaseName, loadTemplate } from "./common"
import { KubernetesPluginContext } from "../config"
import { getForwardablePorts } from "../port-forward"
import { KubernetesServerResource } from "../types"
import { getActionNamespace, getActionNamespaceStatus } from "../namespace"
import { getTargetResource, isWorkload } from "../util"
import { startDevModeSyncs } from "../dev-mode"
import { isConfiguredForDevMode, isConfiguredForLocalMode } from "../status/status"
import { KubeApi } from "../api"
import Bluebird from "bluebird"
import { getK8sIngresses } from "../status/ingress"
import { DeployActionHandler } from "../../../plugin/action-types"
import { HelmDeployAction } from "./config"

export const gardenCloudAECPauseAnnotation = "garden.io/aec-status"

const helmStatusMap: { [status: string]: ServiceState } = {
  unknown: "unknown",
  deployed: "ready",
  deleted: "missing",
  superseded: "stopped",
  failed: "unhealthy",
  deleting: "stopped",
}

interface HelmStatusDetail {
  remoteResources?: KubernetesServerResource[]
}

export type HelmServiceStatus = ServiceStatus<HelmStatusDetail>

export const getHelmDeployStatus: DeployActionHandler<"getStatus", HelmDeployAction> = async (params) => {
  const { ctx, action, log, devMode, localMode } = params
  const k8sCtx = <KubernetesPluginContext>ctx
  const provider = k8sCtx.provider

  const releaseName = getReleaseName(action)

  const detail: HelmStatusDetail = {}
  let state: ServiceState
  let helmStatus: ServiceStatus

  const namespaceStatus = await getActionNamespaceStatus({
    ctx: k8sCtx,
    log,
    action,
    provider,
  })

  let deployedWithDevMode: boolean | undefined
  let deployedWithLocalMode: boolean | undefined

  try {
    helmStatus = await getReleaseStatus({ ctx: k8sCtx, action, releaseName, log, devMode, localMode })
    state = helmStatus.state
    deployedWithDevMode = helmStatus.devMode
    deployedWithLocalMode = helmStatus.localMode
  } catch (err) {
    state = "missing"
  }

  let forwardablePorts: ForwardablePort[] = []
  let ingresses: ServiceIngress[] = []

  const spec = action.getSpec()

  if (state !== "missing") {
    const deployedResources = await getRenderedResources({ ctx: k8sCtx, action, releaseName, log })

    forwardablePorts = !!deployedWithLocalMode ? [] : getForwardablePorts(deployedResources, service)
    ingresses = getK8sIngresses(deployedResources)

    if (state === "ready") {
      // Local mode always takes precedence over dev mode
      if (localMode && spec.localMode) {
        const resourceSpec = spec.localMode.target || spec.defaultTarget

        if (resourceSpec) {
          const target = await getTargetResource({
            ctx: k8sCtx,
            log,
            provider: k8sCtx.provider,
            action,
            manifests: deployedResources,
            resourceSpec,
          })

          if (!isConfiguredForLocalMode(target)) {
            state = "outdated"
          }
        }
      } else if (devMode && spec.devMode) {
        // Need to start the dev-mode sync here, since the deployment handler won't be called.

        // First make sure we don't fail if resources arent't actually properly configured (we don't want to throw in
        // the status handler, generally)

        const defaultNamespace = await getActionNamespace({
          ctx: k8sCtx,
          log,
          action,
          provider: k8sCtx.provider,
        })

        await Bluebird.map(spec.devMode.syncs, async (syncSpec) => {
          const resourceSpec = syncSpec.target || spec.defaultTarget

          if (!resourceSpec) {
            // Note: This is caught elsewhere with a warning
            return
          }

          const target = await getTargetResource({
            ctx: k8sCtx,
            log,
            provider: k8sCtx.provider,
            action,
            manifests: deployedResources,
            resourceSpec,
          })

          // Make sure we don't fail if the service isn't actually properly configured (we don't want to throw in the
          // status handler, generally)
          if (!isConfiguredForDevMode(target)) {
            state = "outdated"
            return
          }
        })

        if (state === "ready") {
          await startDevModeSyncs({
            ctx: k8sCtx,
            log,
            action,
            actionDefaults: spec.devMode.defaults || {},
            defaultTarget: spec.defaultTarget,
            basePath: action.getBasePath(),
            defaultNamespace,
            manifests: deployedResources,
            syncs: spec.devMode.syncs,
          })
        }
      }
    }
  }

  return {
    forwardablePorts,
    state,
    version: state === "ready" ? action.getVersionString() : undefined,
    detail,
    devMode: deployedWithDevMode,
    localMode: deployedWithLocalMode,
    namespaceStatuses: [namespaceStatus],
    ingresses,
  }
}

export async function getRenderedResources({
  ctx,
  releaseName,
  log,
  action,
}: {
  ctx: KubernetesPluginContext
  releaseName: string
  log: LogEntry
  action: HelmDeployAction
}) {
  const namespace = await getActionNamespace({
    ctx,
    log,
    action,
    provider: ctx.provider,
  })

  return loadTemplate(
    await helm({
      ctx,
      log,
      namespace,
      args: ["get", "manifest", releaseName],
    })
  )
}

export async function getReleaseStatus({
  ctx,
  action,
  releaseName,
  log,
  devMode,
  localMode,
}: {
  ctx: KubernetesPluginContext
  action: HelmDeployAction
  releaseName: string
  log: LogEntry
  devMode: boolean
  localMode: boolean
}): Promise<ServiceStatus> {
  try {
    log.silly(`Getting the release status for ${releaseName}`)
    const namespace = await getActionNamespace({
      ctx,
      log,
      action,
      provider: ctx.provider,
    })

    const res = JSON.parse(await helm({ ctx, log, namespace, args: ["status", releaseName, "--output", "json"] }))

    let state = helmStatusMap[res.info.status] || "unknown"
    let values = {}

    let devModeEnabled = false
    let localModeEnabled = false

    if (state === "ready") {
      // Make sure the right version is deployed
      values = JSON.parse(
        await helm({
          ctx,
          log,
          namespace,
          args: ["get", "values", releaseName, "--output", "json"],
        })
      )

      const deployedVersion = values[".garden"] && values[".garden"].version
      devModeEnabled = values[".garden"] && values[".garden"].devMode === true
      localModeEnabled = values[".garden"] && values[".garden"].localMode === true

      if (
        (devMode && !devModeEnabled) ||
        (localMode && !localModeEnabled) ||
        (!localMode && localModeEnabled) || // this is still a valid case for local-mode
        !deployedVersion ||
        deployedVersion !== action.getVersionString()
      ) {
        state = "outdated"
      }

      // If ctx.cloudApi is defined, the user is logged in and they might be trying to deploy to an environment
      // that could have been paused by Garden Cloud's AEC functionality. We therefore make sure to check for
      // the annotations Garden Cloud adds to Helm Deployments and StatefulSets when pausing an environment.
      if (ctx.cloudApi && (await isPaused({ ctx, namespace, action, releaseName, log }))) {
        state = "outdated"
      }
    }

    return {
      state,
      detail: { ...res, values },
      devMode: devModeEnabled,
      localMode: localModeEnabled,
    }
  } catch (err) {
    if (err.message.includes("release: not found")) {
      return { state: "missing", detail: {} }
    } else {
      throw err
    }
  }
}

/**
 *  Returns Helm workload resources that have been marked as "paused" by Garden Cloud's AEC functionality
 */
export async function getPausedResources({
  ctx,
  action,
  namespace,
  releaseName,
  log,
}: {
  ctx: KubernetesPluginContext
  namespace: string
  action: HelmDeployAction
  releaseName: string
  log: LogEntry
}) {
  const api = await KubeApi.factory(log, ctx, ctx.provider)
  const renderedResources = await getRenderedResources({ ctx, action, releaseName, log })
  const workloads = renderedResources.filter(isWorkload)
  const deployedResources = await Bluebird.all(
    workloads.map((workload) => api.readBySpec({ log, namespace, manifest: workload }))
  )

  const pausedWorkloads = deployedResources.filter((resource) => {
    return resource?.metadata?.annotations?.[gardenCloudAECPauseAnnotation] === "paused"
  })
  return pausedWorkloads
}

async function isPaused({
  ctx,
  action,
  namespace,
  releaseName,
  log,
}: {
  ctx: KubernetesPluginContext
  namespace: string
  action: HelmDeployAction
  releaseName: string
  log: LogEntry
}) {
  return (await getPausedResources({ ctx, action, namespace, releaseName, log })).length > 0
}
