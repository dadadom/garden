/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { actionParamsSchema, PluginDeployActionParamsBase } from "../../base"
import { dedent } from "../../../util/string"
import { ForwardablePort, forwardablePortKeys } from "../../../types/service"
import { joi } from "../../../config/common"
import { DeployAction } from "../../../actions/deploy"
import { ActionTypeHandlerSpec } from "../base/base"
import { Resolved } from "../../../actions/types"

type StopPortForwardParams<T extends DeployAction> = PluginDeployActionParamsBase<T> & ForwardablePort

export class StopDeployPortForward<T extends DeployAction = DeployAction> extends ActionTypeHandlerSpec<
  "Deploy",
  StopPortForwardParams<Resolved<T>>,
  {}
> {
  description = dedent`
    Close a port forward created by \`getPortForward\`.
  `
  paramsSchema = () => actionParamsSchema().keys(forwardablePortKeys())
  resultSchema = () => joi.object().keys({})
}
