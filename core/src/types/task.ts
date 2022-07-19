/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { GardenModule } from "./module"
import { TaskConfig, taskConfigSchema } from "../config/task"
import { getEntityVersion } from "../vcs/vcs"
import { joi, joiPrimitive, joiUserIdentifier, moduleVersionSchema, versionStringSchema } from "../config/common"
import { namespaceStatusSchema } from "../plugin/base"
import { deline } from "../util/string"

export interface GardenTask<M extends GardenModule = GardenModule> {
  name: string
  description?: string
  module: M
  disabled: boolean
  config: M["taskConfigs"][0]
  spec: M["taskConfigs"][0]["spec"]
  version: string
}

export const taskSchema = () =>
  joi
    .object()
    .options({ presence: "required" })
    .keys({
      name: joiUserIdentifier().description("The name of the task."),
      description: joi.string().optional().description("A description of the task."),
      disabled: joi.boolean().default(false).description("Set to true if the task or its module is disabled."),
      module: joi.object().unknown(true),
      config: taskConfigSchema(),
      spec: joi
        .object()
        .meta({ extendable: true })
        .description("The configuration of the task (specific to each plugin)."),
      version: versionStringSchema().description("The version of the task."),
    })

export function taskFromConfig<M extends GardenModule = GardenModule>(module: M, config: TaskConfig): GardenTask<M> {
  return {
    name: config.name,
    module,
    disabled: module.disabled || config.disabled,
    config,
    spec: config.spec,
    version: getEntityVersion(module, config),
  }
}

export const taskVersionSchema = () =>
  moduleVersionSchema().description(deline`
    The task run's version. In addition to the parent module's version, this also
    factors in the module versions of the tasks's runtime dependencies (if any).`)

export const taskResultSchema = () =>
  joi
    .object()
    .unknown(true)
    .keys({
      moduleName: joi.string().description("The name of the module that the task belongs to, if applicable."),
      taskName: joi.string().description("The name of the task that was run."),
      command: joi.sparseArray().items(joi.string().allow("")).required().description("The command that the task ran."),
      version: joi.string().description("The string version of the task."),
      success: joi.boolean().required().description("Whether the task was successfully run."),
      startedAt: joi.date().required().description("When the task run was started."),
      completedAt: joi.date().required().description("When the task run was completed."),
      log: joi.string().required().allow("").description("The output log from the run."),
      outputs: joi
        .object()
        .pattern(/.+/, joiPrimitive())
        .description("A map of primitive values, output from the task."),
      namespaceStatus: namespaceStatusSchema().optional(),
    })
