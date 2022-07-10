/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { Command, CommandGroup, CommandParams, CommandResult } from "./base"
import { NotFoundError } from "../exceptions"
import dedent from "dedent"
import { ServiceStatusMap, serviceStatusSchema } from "../types/service"
import { printHeader } from "../logger/util"
import { DeleteSecretResult } from "../plugin/handlers/provider/deleteSecret"
import { EnvironmentStatusMap } from "../plugin/handlers/provider/getEnvironmentStatus"
import { DeleteDeployTask, deletedDeployStatuses } from "../tasks/delete-service"
import { joi, joiIdentifierMap } from "../config/common"
import { environmentStatusSchema } from "../config/status"
import { BooleanParameter, StringParameter, StringsParameter } from "../cli/params"
import { deline } from "../util/string"
import { uniqByName } from "../util/util"
import { isDeployAction } from "../actions/deploy"

export class DeleteCommand extends CommandGroup {
  name = "delete"
  aliases = ["del"]
  help = "Delete configuration or objects."

  subCommands = [DeleteSecretCommand, DeleteEnvironmentCommand, DeleteDeployCommand]
}

const deleteSecretArgs = {
  provider: new StringParameter({
    help: "The name of the provider to remove the secret from.",
    required: true,
  }),
  key: new StringParameter({
    help: "The key of the configuration variable. Separate with dots to get a nested key (e.g. key.nested).",
    required: true,
  }),
}

type DeleteSecretArgs = typeof deleteSecretArgs

export class DeleteSecretCommand extends Command<typeof deleteSecretArgs> {
  name = "secret"
  help = "Delete a secret from the environment."
  protected = true

  description = dedent`
    Returns with an error if the provided key could not be found by the provider.

    Examples:

        garden delete secret kubernetes somekey
        garden del secret local-kubernetes some-other-key
  `

  arguments = deleteSecretArgs

  printHeader({ headerLog }) {
    printHeader(headerLog, "Delete secrete", "skull_and_crossbones")
  }

  async action({ garden, log, args }: CommandParams<DeleteSecretArgs>): Promise<CommandResult<DeleteSecretResult>> {
    const key = args.key!
    const actions = await garden.getActionRouter()
    const result = await actions.provider.deleteSecret({ log, pluginName: args.provider!, key })

    if (result.found) {
      log.info(`Deleted config key ${args.key}`)
    } else {
      throw new NotFoundError(`Could not find config key ${args.key}`, { key })
    }

    return { result }
  }
}

const dependantsFirstOpt = {
  "dependants-first": new BooleanParameter({
    help: deline`
      Delete services in reverse dependency order. That is, if service-a has a dependency on service-b, service-a
      will be deleted before service-b when calling garden delete environment service-a,service-b --dependants-first.
      When this flag is not used, all services in the project are deleted simultaneously.
    `,
  }),
}

const deleteEnvironmentOpts = dependantsFirstOpt

type DeleteEnvironmentOpts = typeof dependantsFirstOpt

interface DeleteEnvironmentResult {
  providerStatuses: EnvironmentStatusMap
  deployStatuses: ServiceStatusMap
}

export class DeleteEnvironmentCommand extends Command<{}, DeleteEnvironmentOpts> {
  name = "environment"
  aliases = ["env"]
  help = "Deletes a running environment."

  protected = true
  streamEvents = true

  options = deleteEnvironmentOpts

  description = dedent`
    This will delete everything deployed in the specified environment, and trigger providers to clear up any other resources
    and reset it. When you then run \`garden deploy\` after, the environment will be reconfigured.

    This can be useful if you find the environment to be in an inconsistent state, or need/want to free up
    resources.
  `

  outputsSchema = () =>
    joi.object().keys({
      providerStatuses: joiIdentifierMap(environmentStatusSchema()).description(
        "The status of each provider in the environment."
      ),
      deployStatuses: joiIdentifierMap(serviceStatusSchema()).description(
        "The status of each service in the environment."
      ),
    })

  printHeader({ headerLog }) {
    printHeader(headerLog, `Deleting environment`, "skull_and_crossbones")
  }

  async action({
    garden,
    log,
    opts,
  }: CommandParams<{}, DeleteEnvironmentOpts>): Promise<CommandResult<DeleteEnvironmentResult>> {
    const actions = await garden.getActionRouter()
    const graph = await garden.getConfigGraph({ log, emit: true })
    const serviceStatuses = await actions.deleteDeploys({
      graph,
      log,
      dependantsFirst: opts["dependants-first"],
    })

    log.info("")

    const providerStatuses = await actions.provider.cleanupAll(log)

    return { result: { deployStatuses: serviceStatuses, providerStatuses } }
  }
}

const deleteDeployArgs = {
  names: new StringsParameter({
    help:
      "The name(s) of the deploy(s) (or services if using modules) to delete. Use comma as a separator to specify multiple names.",
  }),
}
type DeleteDeployArgs = typeof deleteDeployArgs

const deleteDeployOpts = {
  ...dependantsFirstOpt,
  "with-dependants": new BooleanParameter({
    help: deline`
      Also delete deployments/services that have dependencies on one of the deployments/services specified as CLI arguments
      (recursively).  When used, this option implies --dependants-first. Note: This option has no effect unless a list
      of names is specified as CLI arguments (since then, every deploy/service in the project will be deleted).
    `,
  }),
}
type DeleteDeployOpts = typeof deleteDeployOpts

export class DeleteDeployCommand extends Command<DeleteDeployArgs, DeleteDeployOpts> {
  name = "deploy"
  aliases = ["deploys", "service", "services"]
  help = "Deletes running deploys (or services if using modules)."
  arguments = deleteDeployArgs

  protected = true
  workflows = true
  streamEvents = true

  description = dedent`
    Deletes (i.e. un-deploys) the specified actions. Deletes all deploys/services in the project if no arguments are provided.
    Note that this command does not take into account any deploys depending on the deleted actions, and might
    therefore leave the project in an unstable state. Running \`garden deploy\` after will re-deploy anything missing.

    Examples:

        garden delete deploy my-service # deletes my-service
        garden delete deploy            # deletes all deployed services in the project
  `

  outputsSchema = () =>
    joiIdentifierMap(serviceStatusSchema()).description("A map of statuses for all the deleted deploys.")

  printHeader({ headerLog }) {
    printHeader(headerLog, "Delete deploy", "skull_and_crossbones")
  }

  async action({ garden, log, args, opts }: CommandParams<DeleteDeployArgs, DeleteDeployOpts>): Promise<CommandResult> {
    const graph = await garden.getConfigGraph({ log, emit: true })
    let actions = graph.getDeploys({ names: args.names })

    if (actions.length === 0) {
      log.warn({ msg: "No deploys found. Aborting." })
      return { result: {} }
    }

    if (opts["with-dependants"]) {
      // Then we include service dependants (recursively) in the list of services to delete
      actions = uniqByName([
        ...actions,
        ...actions.flatMap((s) =>
          graph.getDependants({ kind: "deploy", name: s.name, recursive: true }).filter(isDeployAction)
        ),
      ])
    }

    const dependantsFirst = opts["dependants-first"] || opts["with-dependants"]
    const deleteDeployNames = actions.map((a) => a.name)

    const tasks = actions.map((action) => {
      return new DeleteDeployTask({
        garden,
        graph,
        log,
        action,
        deleteDeployNames,
        dependantsFirst,
        force: false,
        forceActions: [],
        devModeDeployNames: [],
        localModeDeployNames: [],
        fromWatch: false,
      })
    })

    const result = deletedDeployStatuses(await garden.processTasks(tasks))

    return { result }
  }
}
