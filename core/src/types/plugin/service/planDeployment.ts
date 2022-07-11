/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { PluginServiceActionParamsBase, serviceActionParamsSchema } from "../base"
import { dedent } from "../../../util/string"
import { GardenModule } from "../../module"
import { RuntimeContext, runtimeContextSchema } from "../../../runtime-context"
import { deploymentPlanSchema } from "../../service"

export interface PlanDeploymentParams<M extends GardenModule = GardenModule, S extends GardenModule = GardenModule>
  extends PluginServiceActionParamsBase<M, S> {
  // devMode: boolean
  // force: boolean
  // hotReload: boolean
  // localMode: boolean
  planPath: string
  runtimeContext: RuntimeContext
}

export const planDeployment = () => ({
  description: dedent`
    Prepare a deployment plan for specified service.

    Called by the \`garden plan\` command.
  `,
  paramsSchema: serviceActionParamsSchema().keys({
    // devMode: joi.boolean().default(false).description("Whether the service should be configured in dev mode."),
    // force: joi.boolean().description("Whether to force a re-deploy, even if the service is already deployed."),
    runtimeContext: runtimeContextSchema(),
    // hotReload: joi.boolean().default(false).description("Whether to configure the service for hot-reloading."),
    // localMode: joi.boolean().default(false).description("Whether the service should be configured in local mode."),
  }),
  resultSchema: deploymentPlanSchema(),
})
