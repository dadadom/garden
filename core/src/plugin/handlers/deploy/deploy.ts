/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { actionParamsSchema, PluginDeployActionParamsBase } from "../../base"
import { dedent } from "../../../util/string"
import { RuntimeContext, runtimeContextSchema } from "../../../runtime-context"
import { ServiceStatus, serviceStatusSchema } from "../../../types/service"
import { joi } from "../../../config/common"
import { ActionTypeHandlerSpec } from "../base/base"
import { DeployAction } from "../../../actions/deploy"
import { GetActionOutputType } from "../../../actions/base"

interface DeployParams<T extends DeployAction> extends PluginDeployActionParamsBase<T> {
  devMode: boolean
  force: boolean
  runtimeContext: RuntimeContext
}

export class DoDeployAction<T extends DeployAction = DeployAction> extends ActionTypeHandlerSpec<
  "deploy",
  DeployParams<T>,
  ServiceStatus<any, GetActionOutputType<T>>
> {
  description = dedent`
    Deploy the specified service. This should wait until the service is ready and accessible,
    and fail if the service doesn't reach a ready state.

    Called by the \`garden deploy\` and \`garden dev\` commands.
  `

  paramsSchema = () =>
    actionParamsSchema().keys({
      devMode: joi.boolean().default(false).description("Whether the service should be configured in dev mode."),
      force: joi.boolean().description("Whether to force a re-deploy, even if the service is already deployed."),
      runtimeContext: runtimeContextSchema(),
    })

  resultSchema = () => serviceStatusSchema()
}
