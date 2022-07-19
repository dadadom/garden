/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import chalk from "chalk"
import { keyBy } from "lodash"

import { ConfigurationError } from "../../exceptions"
import { createGardenPlugin } from "../../plugin/plugin"
import { containerHelpers, defaultDockerfileName } from "./helpers"
import { ContainerActionConfig, ContainerModule, containerModuleSpecSchema } from "./moduleConfig"
import { buildContainerModule, getContainerBuildStatus } from "./build"
import { ConfigureModuleParams } from "../../plugin/handlers/module/configure"
import { joi } from "../../config/common"
import { publishContainerModule } from "./publish"
import { SuggestModulesParams, SuggestModulesResult } from "../../types/plugin/module/suggestModules"
import { listDirectory } from "../../util/fs"
import { dedent } from "../../util/string"
import { Provider, GenericProviderConfig, providerConfigBaseSchema } from "../../config/provider"
import { GetModuleOutputsParams } from "../../types/plugin/module/getModuleOutputs"
import { ConvertModuleParams } from "../../plugin/handlers/module/convert"
import { ExecActionConfig } from "../exec/config"
import {
  containerDeploySchema,
  containerRunActionSchema,
  containerTestActionSchema,
  dockerImageBuildSpecSchema,
} from "./config"

export interface ContainerProviderConfig extends GenericProviderConfig {}
export type ContainerProvider = Provider<ContainerProviderConfig>

export interface ContainerBuildOutputs {
  "local-image-name": string
  "local-image-id": string
  "deployment-image-name": string
  "deployment-image-id": string
}

export const containerBuildOutputsSchema = () =>
  joi.object().keys({
    "local-image-name": joi
      .string()
      .required()
      .description("The name of the image (without tag/version) that the module uses for local builds and deployments.")
      .example("my-module"),
    "local-image-id": joi
      .string()
      .required()
      .description(
        "The full ID of the image (incl. tag/version) that the module uses for local builds and deployments."
      )
      .example("my-module:v-abf3f8dca"),
    "deployment-image-name": joi
      .string()
      .required()
      .description("The name of the image (without tag/version) that the module will use during deployment.")
      .example("my-deployment-registry.io/my-org/my-module"),
    "deployment-image-id": joi
      .string()
      .required()
      .description("The full ID of the image (incl. tag/version) that the module will use during deployment.")
      .example("my-deployment-registry.io/my-org/my-module:v-abf3f8dca"),
  })

const taskOutputsSchema = joi.object().keys({
  log: joi
    .string()
    .allow("")
    .default("")
    .description(
      "The full log from the executed task. " +
        "(Pro-tip: Make it machine readable so it can be parsed by dependant tasks and services!)"
    ),
})

export async function configureContainerModule({ log, moduleConfig }: ConfigureModuleParams<ContainerModule>) {
  // validate services
  moduleConfig.serviceConfigs = moduleConfig.spec.services.map((spec) => {
    // make sure ports are correctly configured
    const name = spec.name
    const definedPorts = spec.ports
    const portsByName = keyBy(spec.ports, "name")

    for (const ingress of spec.ingresses) {
      const ingressPort = ingress.port

      if (!portsByName[ingressPort]) {
        throw new ConfigurationError(`Service ${name} does not define port ${ingressPort} defined in ingress`, {
          definedPorts,
          ingressPort,
        })
      }
    }

    if (spec.healthCheck && spec.healthCheck.httpGet) {
      const healthCheckHttpPort = spec.healthCheck.httpGet.port

      if (!portsByName[healthCheckHttpPort]) {
        throw new ConfigurationError(
          `Service ${name} does not define port ${healthCheckHttpPort} defined in httpGet health check`,
          { definedPorts, healthCheckHttpPort }
        )
      }
    }

    if (spec.healthCheck && spec.healthCheck.tcpPort) {
      const healthCheckTcpPort = spec.healthCheck.tcpPort

      if (!portsByName[healthCheckTcpPort]) {
        throw new ConfigurationError(
          `Service ${name} does not define port ${healthCheckTcpPort} defined in tcpPort health check`,
          { definedPorts, healthCheckTcpPort }
        )
      }
    }

    for (const volume of spec.volumes) {
      if (volume.module) {
        // TODO-G2: change this to validation instead, require explicit dependency
        moduleConfig.build.dependencies.push({ name: volume.module, copy: [] })
        spec.dependencies.push(volume.module)
      }
    }

    return {
      name,
      dependencies: spec.dependencies,
      disabled: spec.disabled,
      spec,
    }
  })

  moduleConfig.testConfigs = moduleConfig.spec.tests.map((t) => {
    for (const volume of t.volumes) {
      if (volume.module) {
        moduleConfig.build.dependencies.push({ name: volume.module, copy: [] })
        t.dependencies.push(volume.module)
      }
    }

    return {
      name: t.name,
      dependencies: t.dependencies,
      disabled: t.disabled,
      spec: t,
      timeout: t.timeout,
    }
  })

  moduleConfig.taskConfigs = moduleConfig.spec.tasks.map((t) => {
    for (const volume of t.volumes) {
      if (volume.module) {
        moduleConfig.build.dependencies.push({ name: volume.module, copy: [] })
        t.dependencies.push(volume.module)
      }
    }

    return {
      name: t.name,
      cacheResult: t.cacheResult,
      dependencies: t.dependencies,
      disabled: t.disabled,
      spec: t,
      timeout: t.timeout,
    }
  })

  // All the config keys that affect the build version
  moduleConfig.buildConfig = {
    buildArgs: moduleConfig.spec.buildArgs,
    targetImage: moduleConfig.spec.build?.targetImage,
    extraFlags: moduleConfig.spec.extraFlags,
    dockerfile: moduleConfig.spec.dockerfile,
  }

  // Automatically set the include field based on the Dockerfile and config, if not explicitly set
  if (!(moduleConfig.include || moduleConfig.exclude)) {
    moduleConfig.include = await containerHelpers.autoResolveIncludes(moduleConfig, log)
  }

  return { moduleConfig }
}

async function suggestModules({ name, path }: SuggestModulesParams): Promise<SuggestModulesResult> {
  const dockerfiles = (await listDirectory(path, { recursive: false })).filter(
    (filename) => filename.startsWith(defaultDockerfileName) || filename.endsWith(defaultDockerfileName)
  )

  return {
    suggestions: dockerfiles.map((dockerfileName) => {
      return {
        description: `based on found ${chalk.white(dockerfileName)}`,
        module: {
          kind: "Module",
          type: "container",
          name,
          dockerfile: dockerfileName,
        },
      }
    }),
  }
}

export async function getContainerModuleOutputs({ moduleConfig, version }: GetModuleOutputsParams) {
  const deploymentImageName = containerHelpers.getDeploymentImageName(moduleConfig, undefined)
  const deploymentImageId = containerHelpers.getDeploymentImageId(moduleConfig, version, undefined)

  // If there is no Dockerfile (i.e. we don't need to build anything) we use the image field directly.
  // Otherwise we set the tag to the module version.
  const hasDockerfile = containerHelpers.hasDockerfile(moduleConfig, version)
  const localImageId =
    moduleConfig.spec.image && !hasDockerfile
      ? moduleConfig.spec.image
      : containerHelpers.getLocalImageId(moduleConfig, version)

  return {
    outputs: {
      "local-image-name": containerHelpers.getLocalImageName(moduleConfig),
      "local-image-id": localImageId,
      "deployment-image-name": deploymentImageName,
      "deployment-image-id": deploymentImageId,
    },
  }
}

export const gardenPlugin = () =>
  createGardenPlugin({
    name: "container",
    docs: dedent`
      Provides the [container](../module-types/container.md) module type.
      _Note that this provider is currently automatically included, and you do not need to configure it in your project configuration._
    `,

    createActionTypes: {
      build: [
        {
          name: "container",
          docs: dedent`
            Build a Docker container image, and (if applicable) push to a remote registry.
          `,
          outputsSchema: containerBuildOutputsSchema(),
          schema: dockerImageBuildSpecSchema(),
          handlers: {
            // TODO-G2
          },
        },
      ],
      deploy: [
        {
          name: "container",
          docs: dedent`
            Deploy a container image, e.g. in a Kubernetes namespace (when used with the \`kubernetes\` provider).

            This is a simplified abstraction, which can be convenient for simple deployments, but has limited features compared to more platform-specific types. For example, you cannot specify replicas for redundancy, and various platform-specific options are not included. For more flexibility, please look at other Deploy types like [helm](./helm.md) or [kubernetes](./kubernetes.md).
          `,
          schema: containerDeploySchema(),
          handlers: {
            // TODO-G2
          },
        },
      ],
      run: [
        {
          name: "container",
          docs: dedent`
            Run a command in a container image, e.g. in a Kubernetes namespace (when used with the \`kubernetes\` provider).

            This is a simplified abstraction, which can be convenient for simple tasks, but has limited features compared to more platform-specific types. For example, you cannot specify replicas for redundancy, and various platform-specific options are not included. For more flexibility, please look at other Run types like [helm](./helm.md) or [kubernetes](./kubernetes.md).
          `,
          schema: containerRunActionSchema(),
          handlers: {
            // TODO-G2
          },
        },
      ],
      test: [
        {
          name: "container",
          docs: dedent`
            Define a Test which runs a command in a container image, e.g. in a Kubernetes namespace (when used with the \`kubernetes\` provider).

            This is a simplified abstraction, which can be convenient for simple scenarios, but has limited features compared to more platform-specific types. For example, you cannot specify replicas for redundancy, and various platform-specific options are not included. For more flexibility, please look at other Test types like [helm](./helm.md) or [kubernetes](./kubernetes.md).
          `,
          schema: containerTestActionSchema(),
          handlers: {
            // TODO-G2
          },
        },
      ],
    },

    createModuleTypes: [
      {
        name: "container",
        docs: dedent`
          Specify a container image to build or pull from a remote registry.
          You may also optionally specify services to deploy, tasks or tests to run inside the container.

          Note that the runtime services have somewhat limited features in this module type. For example, you cannot
          specify replicas for redundancy, and various platform-specific options are not included. For those, look at
          other module types like [helm](./helm.md) or
          [kubernetes](./kubernetes.md).
        `,
        moduleOutputsSchema: containerBuildOutputsSchema(),
        schema: containerModuleSpecSchema(),
        taskOutputsSchema,
        handlers: {
          configure: configureContainerModule,

          async convert(params: ConvertModuleParams<ContainerModule>) {
            const { module, convertBuildDependency, convertRuntimeDependency, dummyBuild } = params
            const actions: (ContainerActionConfig | ExecActionConfig)[] = []

            let needsContainerBuild = false

            if (containerHelpers.hasDockerfile(module, module.version)) {
              needsContainerBuild = true
            }

            let buildAction: ContainerActionConfig | ExecActionConfig | undefined = undefined

            if (needsContainerBuild) {
              buildAction = {
                kind: "Build",
                type: "container",
                name: module.name,
                ...params.baseFields,

                copyFrom: dummyBuild?.copyFrom,
                allowPublish: module.allowPublish,
                dependencies: module.build.dependencies.map(convertBuildDependency),

                spec: {
                  buildArgs: module.spec.buildArgs,
                  dockerfile: module.spec.dockerfile || defaultDockerfileName,
                  extraFlags: module.spec.extraFlags,
                  publishId: module.spec.image,
                  targetStage: module.spec.build.targetImage,
                  timeout: module.spec.build.timeout,
                },
              }
              actions.push(buildAction)
            } else if (dummyBuild) {
              buildAction = dummyBuild
              actions.push(buildAction)
            }

            function prepRuntimeDeps(deps: string[]) {
              if (buildAction) {
                return deps.map(convertRuntimeDependency)
              } else {
                // If we don't return a Build action, we must still include any declared build dependencies
                return [...module.build.dependencies.map(convertBuildDependency), ...deps.map(convertRuntimeDependency)]
              }
            }

            for (const service of module.serviceConfigs) {
              actions.push({
                kind: "Deploy",
                type: "container",
                name: service.name,
                ...params.baseFields,

                disabled: service.disabled,
                build: buildAction ? buildAction.name : undefined,
                dependencies: prepRuntimeDeps(service.spec.dependencies),

                spec: {
                  ...service.spec,
                },
              })
            }

            for (const task of module.taskConfigs) {
              actions.push({
                kind: "Run",
                type: "container",
                name: task.name,
                ...params.baseFields,

                disabled: task.disabled,
                build: buildAction ? buildAction.name : undefined,
                dependencies: prepRuntimeDeps(task.spec.dependencies),
                timeout: task.spec.timeout ? task.spec.timeout : undefined,

                spec: {
                  ...task.spec,
                  image: buildAction ? undefined : module.spec.image,
                },
              })
            }

            for (const test of module.testConfigs) {
              actions.push({
                kind: "Test",
                type: "container",
                name: module.name + "-" + test.name,
                ...params.baseFields,

                disabled: test.disabled,
                build: buildAction ? buildAction.name : undefined,
                dependencies: prepRuntimeDeps(test.spec.dependencies),
                timeout: test.spec.timeout ? test.spec.timeout : undefined,

                spec: {
                  ...test.spec,
                  image: buildAction ? undefined : module.spec.image,
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

          suggestModules,
          getBuildStatus: getContainerBuildStatus,
          build: buildContainerModule,
          publish: publishContainerModule,
          getModuleOutputs: getContainerModuleOutputs,
        },
      },
    ],
    configSchema: providerConfigBaseSchema(),
    tools: [
      {
        name: "docker",
        description: "The official Docker CLI.",
        type: "binary",
        _includeInGardenImage: true,
        builds: [
          {
            platform: "darwin",
            architecture: "amd64",
            url: "https://download.docker.com/mac/static/stable/x86_64/docker-20.10.9.tgz",
            sha256: "f045f816579a96a45deef25aaf3fc116257b4fb5782b51265ad863dcae21f879",
            extract: {
              format: "tar",
              targetPath: "docker/docker",
            },
          },
          {
            platform: "linux",
            architecture: "amd64",
            url: "https://download.docker.com/linux/static/stable/x86_64/docker-20.10.9.tgz",
            sha256: "caf74e54b58c0b38bb4d96c8f87665f29b684371c9a325562a3904b8c389995e",
            extract: {
              format: "tar",
              targetPath: "docker/docker",
            },
          },
          {
            platform: "windows",
            architecture: "amd64",
            url:
              "https://github.com/rgl/docker-ce-windows-binaries-vagrant/releases/download/v20.10.9/docker-20.10.9.zip",
            sha256: "360ca42101d453022eea17747ae0328709c7512e71553b497b88b7242b9b0ee4",
            extract: {
              format: "zip",
              targetPath: "docker/docker.exe",
            },
          },
        ],
      },
    ],
  })
