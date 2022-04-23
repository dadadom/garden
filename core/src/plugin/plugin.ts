/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import Joi = require("@hapi/joi")
import { joiArray, joiIdentifier, joi, joiSchema } from "../config/common"
import { mapValues } from "lodash"
import { dedent } from "../util/string"
import { pluginCommandSchema, PluginCommand } from "./command"
import { toolSchema, PluginToolSpec } from "./tools"
import { DashboardPage, dashboardPagesSchema } from "./handlers/provider/getDashboardPage"
import {
  createModuleTypeSchema,
  extendModuleTypeSchema,
  ModuleTypeDefinition,
  ModuleTypeExtension,
} from "./moduleTypes"
import { getProviderActionDescriptions, ProviderActionHandlers } from "./providers"
import {
  ActionTypeDefinitions,
  ActionTypeExtensions,
  createActionTypesSchema,
  extendActionTypesSchema,
} from "./actionTypes"
import { PluginContext } from "../plugin-context"

// FIXME: Reduce number of import updates needed
export * from "./base"
export * from "./moduleTypes"
export * from "./providers"

export interface PluginDependency {
  name: string
  optional?: boolean
}

const pluginDependencySchema = () =>
  joi.object().keys({
    name: joi.string().required().description("The name of the plugin."),
    optional: joi
      .boolean()
      .description(
        "If set to true, the dependency is optional, meaning that if it is configured it should be loaded ahead of this plugin, but otherwise it is ignored. This is handy if plugins e.g. need to extend module types from other plugins but otherwise don't require the plugin to function."
      ),
  })

export interface GardenPluginSpec {
  name: string
  base?: string
  docs?: string

  configSchema?: Joi.ObjectSchema
  outputsSchema?: Joi.ObjectSchema

  dependencies?: PluginDependency[]

  handlers?: Partial<ProviderActionHandlers>
  commands?: PluginCommand[]
  tools?: PluginToolSpec[]
  dashboardPages?: DashboardPage[]

  createModuleTypes?: ModuleTypeDefinition[]
  extendModuleTypes?: ModuleTypeExtension[]

  createActionTypes?: ActionTypeDefinitions
  extendActionTypes?: ActionTypeExtensions
}

export interface GardenPlugin extends GardenPluginSpec {
  dependencies: PluginDependency[]

  handlers: Partial<ProviderActionHandlers>
  commands: PluginCommand[]
  dashboardPages: DashboardPage[]

  createModuleTypes: ModuleTypeDefinition[]
  extendModuleTypes: ModuleTypeExtension[]

  createActionTypes: ActionTypeDefinitions
  extendActionTypes: ActionTypeExtensions
}

export interface GardenPluginReference {
  name: string
  callback: GardenPluginCallback
}

export type GardenPluginCallback = () => GardenPlugin

export interface PluginMap {
  [name: string]: GardenPlugin
}

export type RegisterPluginParam = string | GardenPlugin | GardenPluginReference

export const pluginSchema = () =>
  joi
    .object()
    .keys({
      name: joiIdentifier().required().description("The name of the plugin."),
      base: joiIdentifier().description(dedent`
        Name of a plugin to use as a base for this plugin. If you specify this, your provider will inherit all of the
        schema and functionality from the base plugin. Please review other fields for information on how individual
        fields can be overridden or extended.
      `),
      dependencies: joiArray(pluginDependencySchema()).description(dedent`
        Names of plugins that need to be configured prior to this plugin. This plugin will be able to reference the
        configuration from the listed plugins. Note that the dependencies will not be implicitly configured—the user
        will need to explicitly configure them in their project configuration.

        If you specify a \`base\`, these dependencies are added in addition to the dependencies of the base plugin.

        When you specify a dependency which matches another plugin's \`base\`, that plugin will be matched. This
        allows you to depend on at least one instance of a plugin of a certain base type being configured, without
        having to explicitly depend on any specific sub-type of that base. Note that this means that a single declared
        dependency may result in a match with multiple other plugins, if they share a matching base plugin.
      `),

      docs: joi.string().description(dedent`
        A description of the provider, in markdown format. Please provide a useful introduction, and link to any
        other relevant documentation, such as guides, examples and module types.
      `),

      // TODO: make this a JSON/OpenAPI schema for portability
      configSchema: joiSchema().unknown(true).description(dedent`
        The schema for the provider configuration (which the user specifies in the Garden Project configuration).

        If the provider has a \`base\` configured, this schema must either describe a superset of the base plugin
        \`configSchema\` _or_ you must specify a \`configureProvider\` handler which returns a configuration that
        matches the base plugin's schema. This is to guarantee that the handlers from the base plugin get the
        configuration schema they expect.
      `),

      outputsSchema: joiSchema().unknown(true).description(dedent`
        The schema for the provider configuration (which the user specifies in the Garden Project configuration).

        If the provider has a \`base\` configured, this schema must describe a superset of the base plugin
        \`outputsSchema\`.
      `),

      handlers: joi.object().keys(mapValues(getProviderActionDescriptions(), () => joi.func())).description(dedent`
        A map of plugin action handlers provided by the plugin.

        If you specify a \`base\`, you can use this field to add new handlers or override the handlers from the base
        plugin. Any handlers you override will receive a \`base\` parameter with the overridden handler, so that you
        can optionally call the original handler from the base plugin.
      `),

      commands: joi.array().items(pluginCommandSchema()).unique("name").description(dedent`
        List of commands that this plugin exposes (via \`garden plugins <plugin name>\`.

        If you specify a \`base\`, new commands are added in addition to the commands of the base plugin, and if you
        specify a command with the same name as one in the base plugin, you can override the original.
        Any command you override will receive a \`base\` parameter with the overridden handler, so that you can
        optionally call the original command from the base plugin.
      `),

      createModuleTypes: joi.array().items(createModuleTypeSchema()).unique("name").description(dedent`
        List of module types to create.

        If you specify a \`base\`, these module types are added in addition to the module types created by the base
        plugin. To augment the base plugin's module types, use the \`extendModuleTypes\` field.
      `),
      extendModuleTypes: joi.array().items(extendModuleTypeSchema()).unique("name").description(dedent`
        List of module types to extend/override with additional handlers.
      `),

      createActionTypes: createActionTypesSchema().description(dedent`
        Define one or more action types.

        If you specify a \`base\`, these module types are added in addition to the action types created by the base
        plugin. To augment the base plugin's action types, use the \`extendActionTypes\` field.
      `),
      extendActionTypes: extendActionTypesSchema().description(dedent`
        Extend one or more action types by adding new or overriding existing handlers.
      `),

      dashboardPages: dashboardPagesSchema(),

      tools: joi.array().items(toolSchema()).unique("name").description(dedent`
        List of tools that this plugin exposes via \`garden tools <name>\`, and within its own plugin handlers and commands.

        The tools are downloaded automatically on first use, and cached under the user's global \`~/.garden\` directory.

        If multiple plugins specify a tool with the same name, you can reference them prefixed with the plugin name and a period, e.g. \`kubernetes.kubectl\` to pick a specific plugin's command. Otherwise a warning is emitted when running \`garden tools\`, and the tool that's configured by the plugin that is last in the dependency order is used. Since that can often be ambiguous, it is highly recommended to use the fully qualified name in automated scripts.

        If you specify a \`base\`, new tools are added in addition to the tools of the base plugin, and if you specify a tool with the same name as one in the base plugin, you override the one declared in the base.
      `),
    })
    .description("The schema for Garden plugins.")

export const pluginNodeModuleSchema = () =>
  joi
    .object()
    .keys({
      gardenPlugin: pluginSchema().required(),
    })
    .unknown(true)
    .description("A Node.JS module containing a Garden plugin.")

// This doesn't do much at the moment, but it makes sense to make this an SDK function to make it more future-proof
export function createGardenPlugin(spec: GardenPluginSpec): GardenPlugin {
  return {
    ...spec,
    dependencies: spec.dependencies || [],
    commands: spec.commands || [],
    createModuleTypes: spec.createModuleTypes || [],
    extendModuleTypes: spec.extendModuleTypes || [],
    createActionTypes: spec.createActionTypes || {},
    extendActionTypes: spec.extendActionTypes || {},
    handlers: spec.handlers || {},
    dashboardPages: spec.dashboardPages || [],
  }
}

/**
 * A directory inside the project-level `.garden` directory where the plugin can write output files. This can be useful
 * e.g. when the plugin wants to maintain a local cache of some kind.
 */
export function getPluginOutputsPath(ctx: PluginContext, pluginName: string): string {
  return join(ctx.gardenDirPath, `${pluginName}.outputs`)
}
