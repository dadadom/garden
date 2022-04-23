/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { mapValues } from "lodash"
import { ResolvedActionHandlerDescriptions } from "./plugin"
import { ActionTypeHandlerSpec, baseHandlerSchema } from "./handlers/base/base"
import { ValidateAction } from "./handlers/base/validate"
import { BuildAction } from "./handlers/build/build"
import { GetBuildActionStatus } from "./handlers/build/getStatus"
import { PublishBuildAction } from "./handlers/build/publish"
import { RunBuildAction } from "./handlers/build/run"
import { DeleteDeploy } from "./handlers/deploy/delete"
import { ExecInDeploy } from "./handlers/deploy/exec"
import { GetDeployLogs } from "./handlers/deploy/getLogs"
import { GetDeployPortForward } from "./handlers/deploy/getPortForward"
import { GetDeployStatus } from "./handlers/deploy/getStatus"
import { HotReloadDeploy } from "./handlers/deploy/hotReload"
import { RunDeploy } from "./handlers/deploy/run"
import { StopDeployPortForward } from "./handlers/deploy/stopPortForward"
import { GetRunActionResult } from "./handlers/run/getResult"
import { RunAction } from "./handlers/run/run"
import { GetTestActionResult } from "./handlers/test/getResult"
import { TestAction } from "./handlers/test/run"
import { ActionKind, BaseActionConfig } from "../actions/base"
import Joi from "@hapi/joi"
import { joi, joiArray, joiUserIdentifier } from "../config/common"
import titleize from "titleize"
import { BuildActionConfig } from "../actions/build"
import { DeployActionConfig } from "../actions/deploy"
import { RunActionConfig } from "../actions/run"
import { TestActionConfig } from "../actions/test"
import { DeployAction } from "./handlers/deploy/deploy"

type BaseHandlers<C extends BaseActionConfig> = {
  validate: ValidateAction<C>
}

type BuildActionDescriptions<C extends BuildActionConfig = BuildActionConfig> = BaseHandlers<C> & {
  build: BuildAction<C>
  getStatus: GetBuildActionStatus<C>
  publish: PublishBuildAction<C>
  run: RunBuildAction<C>
}

export type BuildActionHandler<
  N extends keyof BuildActionDescriptions,
  C extends BuildActionConfig = BuildActionConfig
> = GetActionTypeHandler<BuildActionDescriptions<C>[N], N>

type DeployActionDescriptions<C extends DeployActionConfig = DeployActionConfig> = BaseHandlers<C> & {
  delete: DeleteDeploy<C>
  deploy: DeployAction<C>
  exec: ExecInDeploy<C>
  getLogs: GetDeployLogs<C>
  getPortForward: GetDeployPortForward<C>
  getStatus: GetDeployStatus<C>
  hotReload: HotReloadDeploy<C>
  run: RunDeploy<C>
  stopPortForward: StopDeployPortForward<C>
}

export type DeployActionHandler<
  N extends keyof DeployActionDescriptions,
  C extends DeployActionConfig = DeployActionConfig
> = GetActionTypeHandler<DeployActionDescriptions<C>[N], N>

type RunActionDescriptions<C extends RunActionConfig = RunActionConfig> = BaseHandlers<C> & {
  getResult: GetRunActionResult<C>
  run: RunAction<C>
}

export type RunActionHandler<
  N extends keyof RunActionDescriptions,
  C extends RunActionConfig = RunActionConfig
> = GetActionTypeHandler<RunActionDescriptions<C>[N], N>

type TestActionDescriptions<C extends TestActionConfig = TestActionConfig> = BaseHandlers<C> & {
  getResult: GetTestActionResult<C>
  run: TestAction<C>
}

export type TestActionHandlers<C extends TestActionConfig = TestActionConfig> = {
  [N in keyof TestActionDescriptions]: GetActionTypeHandler<TestActionDescriptions<C>[N], N>
}

export type TestActionHandler<
  N extends keyof TestActionDescriptions,
  C extends TestActionConfig = TestActionConfig
> = GetActionTypeHandler<TestActionDescriptions<C>[N], N>

interface _ActionTypeHandlerDescriptions {
  build: BuildActionDescriptions
  deploy: DeployActionDescriptions
  run: RunActionDescriptions
  test: TestActionDescriptions
}

// type DescribeActionTypeHandler<T> = T extends ActionTypeHandlerSpec<infer K, infer P, infer R>
//   ? { kind: K; params: P; results: R }
//   : {}

// export type ActionTypeHandlerDescriptions = {
//   [K in keyof _ActionTypeHandlerDescriptions]: {
//     [D in keyof _ActionTypeHandlerDescriptions[K]]: DescribeActionTypeHandler<_ActionTypeHandlerDescriptions[K][D]>
//   }
// }

type ActionTypeHandler<
  K extends ActionKind,
  N, // Name of handler
  P extends {}, // Params type
  R extends {} // Result type
> = ((params: P) => Promise<R>) & {
  actionKind?: K
  handlerName?: N
  pluginName?: string
  base?: ActionTypeHandler<K, N, P, R>
}

// These helpers are needed because TS can't do nested mapping without them
type GetActionTypeParams<T> = T extends ActionTypeHandlerSpec<any, any, any> ? T["_paramsType"] : null
type GetActionTypeResults<T> = T extends ActionTypeHandlerSpec<any, any, any> ? T["_resultType"] : null
type GetActionTypeHandler<T, N> = T extends ActionTypeHandlerSpec<any, any, any>
  ? ActionTypeHandler<T["_kindType"], N, T["_paramsType"], T["_resultType"]>
  : null

export type ActionTypeHandlerParams = {
  [K in ActionKind]: {
    [D in keyof _ActionTypeHandlerDescriptions[K]]: GetActionTypeParams<_ActionTypeHandlerDescriptions[K][D]>
  }
}
export type ActionTypeHandlerResults = {
  [K in ActionKind]: {
    [D in keyof _ActionTypeHandlerDescriptions[K]]: GetActionTypeResults<_ActionTypeHandlerDescriptions[K][D]>
  }
}
export type ActionTypeHandlers = {
  [K in ActionKind]: {
    [D in keyof _ActionTypeHandlerDescriptions[K]]: GetActionTypeHandler<_ActionTypeHandlerDescriptions[K][D], D>
  }
}

export type ResolvedActionTypeHandlerDescriptions = {
  [K in ActionKind]: ResolvedActionHandlerDescriptions
}

// It takes a short while to resolve all these schemas, so we cache the result
let _actionTypeHandlerDescriptions: ResolvedActionTypeHandlerDescriptions

export function getActionTypeHandlerDescriptions(): ResolvedActionTypeHandlerDescriptions {
  if (_actionTypeHandlerDescriptions) {
    return _actionTypeHandlerDescriptions
  }

  const descriptions: _ActionTypeHandlerDescriptions = {
    build: {
      validate: new ValidateAction(),
      build: new BuildAction(),
      getStatus: new GetBuildActionStatus(),
      publish: new PublishBuildAction(),
      run: new RunBuildAction(),
    },
    deploy: {
      validate: new ValidateAction(),
      delete: new DeleteDeploy(),
      deploy: new DeployAction(),
      exec: new ExecInDeploy(),
      getLogs: new GetDeployLogs(),
      getPortForward: new GetDeployPortForward(),
      getStatus: new GetDeployStatus(),
      hotReload: new HotReloadDeploy(),
      run: new RunDeploy(),
      stopPortForward: new StopDeployPortForward(),
    },
    run: {
      validate: new ValidateAction(),
      getResult: new GetRunActionResult(),
      run: new RunAction(),
    },
    test: {
      validate: new ValidateAction(),
      getResult: new GetTestActionResult(),
      run: new TestAction(),
    },
  }

  _actionTypeHandlerDescriptions = mapValues(descriptions, (byType) => {
    return mapValues(byType, (cls) => {
      return {
        description: cls.description,
        required: cls.required,
        paramsSchema: cls.paramsSchema().keys({
          base: baseHandlerSchema(),
        }),
        resultSchema: cls.resultSchema(),
      }
    })
  })

  return _actionTypeHandlerDescriptions
}

export interface ActionTypeExtension<K extends ActionKind> {
  handlers: Partial<ActionTypeHandlers[K]>
  name: string
}

export interface ActionTypeDefinition<K extends ActionKind> extends ActionTypeExtension<K> {
  base?: string
  docs: string
  // TODO: specify the schemas using primitives (e.g. JSONSchema/OpenAPI) and not Joi objects
  schema: Joi.ObjectSchema
  outputsSchema?: Joi.ObjectSchema
  title?: string
}

export type ActionTypeExtensions = {
  [K in ActionKind]?: ActionTypeExtension<K>[]
}
export type ActionTypeDefinitions = {
  [K in ActionKind]?: ActionTypeDefinition<K>[]
}

const createActionTypeSchema = (kind: ActionKind) => {
  const titleKind = titleize(kind)
  const descriptions = getActionTypeHandlerDescriptions()

  return joi
    .object()
    .keys({
      name: joiUserIdentifier().description(`The name of the ${titleKind} type to create.`),
      handlers: mapValues(descriptions[kind], (d) => {
        const schema = baseHandlerSchema().description(d.description)
        return d.required ? schema.required() : schema
      }),
    })
    .description(`Define a ${titleKind} action.`)
}

export const createActionTypesSchema = () => {
  const descriptions = getActionTypeHandlerDescriptions()
  return joi
    .object()
    .keys(mapValues(descriptions, (_, k: ActionKind) => joiArray(createActionTypeSchema(k)).unique("name")))
}

const extendActionTypeSchema = (kind: string) => {
  const titleKind = titleize(kind)
  const descriptions = getActionTypeHandlerDescriptions()

  return joi
    .object()
    .keys({
      name: joiUserIdentifier().description(`The name of the ${titleKind} action type to extend.`),
      handlers: mapValues(descriptions[kind], (d) => baseHandlerSchema().description(d.description)),
    })
    .description(`Extend a ${titleKind} action.`)
}

export const extendActionTypesSchema = () => {
  const descriptions = getActionTypeHandlerDescriptions()
  return joi.object().keys(mapValues(descriptions, (_, k) => joiArray(extendActionTypeSchema(k)).unique("name")))
}
