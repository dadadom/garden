/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { actionParamsSchema, PluginDeployActionParamsBase } from "../../../plugin/base"
import { dedent } from "../../../util/string"
import { RuntimeContext, runtimeContextSchema } from "../../../runtime-context"
import { serviceStatusSchema } from "../../../types/service"
import { joi } from "../../../config/common"
import { DeployActionSpec } from "../../../actions/deploy"

export interface DeployParams<T extends DeployActionSpec = DeployActionSpec> extends PluginDeployActionParamsBase<T> {
  devMode: boolean
  force: boolean
  hotReload: boolean
  runtimeContext: RuntimeContext
}

export const doDeploy = () => ({
  description: dedent`
    Deploy the specified service. This should wait until the service is ready and accessible,
    and fail if the service doesn't reach a ready state.

    Called by the \`garden deploy\` and \`garden dev\` commands.
  `,
  paramsSchema: actionParamsSchema().keys({
    devMode: joi.boolean().default(false).description("Whether the service should be configured in dev mode."),
    force: joi.boolean().description("Whether to force a re-deploy, even if the service is already deployed."),
    runtimeContext: runtimeContextSchema(),
    hotReload: joi.boolean().default(false).description("Whether to configure the service for hot-reloading."),
  }),
  resultSchema: serviceStatusSchema(),
})