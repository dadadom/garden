/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import Bluebird from "bluebird"
import chalk from "chalk"
import { readFile } from "fs-extra"
import { flatten } from "lodash"
import { join } from "path"

import { getModuleWatchTasks } from "../tasks/helpers"
import { Command, CommandParams, CommandResult, handleProcessResults, PrepareParams } from "./base"
import { STATIC_DIR } from "../constants"
import { processActions } from "../process"
import { GardenModule } from "../types/module"
import { getTestTasksFromModule } from "../tasks/test"
import { ConfigGraph } from "../graph/config-graph"
import { getDevModeModules, getMatchingServiceNames } from "./helpers"
import { startServer } from "../server/server"
import { BuildTask } from "../tasks/build"
import { DeployTask } from "../tasks/deploy"
import { Garden } from "../garden"
import { LogEntry } from "../logger/log-entry"
import { BooleanParameter, StringsParameter } from "../cli/params"
import { printHeader } from "../logger/util"
import { GardenService } from "../types/service"
import deline = require("deline")
import dedent = require("dedent")
import moment = require("moment")

const ansiBannerPath = join(STATIC_DIR, "garden-banner-2.txt")

const devArgs = {
  services: new StringsParameter({
    help: `Specify which services to develop (defaults to all configured services).`,
  }),
}

const devOpts = {
  "force": new BooleanParameter({ help: "Force redeploy of service(s)." }),
  "local-mode": new StringsParameter({
    help: deline`[EXPERIMENTAL] The name(s) of the service(s) to be started locally with local mode enabled.
    Use comma as a separator to specify multiple services. Use * to deploy all
    services with local mode enabled. When this option is used,
    the command is run in persistent mode.

    This always takes the precedence over the dev mode if there are any conflicts,
    i.e. if the same services are passed to both \`--dev\` and \`--local\` options.
    `,
    alias: "local",
  }),
  "skip-tests": new BooleanParameter({
    help: "Disable running the tests.",
  }),
  "test-names": new StringsParameter({
    help:
      "Filter the tests to run by test name across all modules (leave unset to run all tests). " +
      "Accepts glob patterns (e.g. integ* would run both 'integ' and 'integration').",
    alias: "tn",
  }),
}

export type DevCommandArgs = typeof devArgs
export type DevCommandOpts = typeof devOpts

// TODO: allow limiting to certain modules and/or services
export class DevCommand extends Command<DevCommandArgs, DevCommandOpts> {
  name = "dev"
  help = "Starts the garden development console."
  protected = true

  // Currently it doesn't make sense to do file watching except in the CLI
  cliOnly = true

  streamEvents = true

  description = dedent`
    The Garden dev console is a combination of the \`build\`, \`deploy\` and \`test\` commands.
    It builds, deploys and tests all your modules and services, and re-builds, re-deploys and re-tests
    as you modify the code.

    Examples:

        garden dev
        garden dev --local=service-1,service-2    # enable local mode for service-1 and service-2
        garden dev --local=*                      # enable local mode for all compatible services
        garden dev --skip-tests=                  # skip running any tests
        garden dev --force                        # force redeploy of services when the command starts
        garden dev --name integ                   # run all tests with the name 'integ' in the project
        garden test --name integ*                 # run all tests with the name starting with 'integ' in the project
  `

  arguments = devArgs
  options = devOpts

  private garden?: Garden

  printHeader({ headerLog }) {
    printHeader(headerLog, "Dev", "keyboard")
  }

  isPersistent() {
    return true
  }

  async prepare({ headerLog, footerLog }: PrepareParams<DevCommandArgs, DevCommandOpts>) {
    // print ANSI banner image
    if (chalk.supportsColor && chalk.supportsColor.level > 2) {
      const data = await readFile(ansiBannerPath)
      headerLog.info(data.toString())
    }

    headerLog.info(chalk.gray.italic(`Good ${getGreetingTime()}! Let's get your environment wired up...`))
    headerLog.info("")

    this.server = await startServer({ log: footerLog })
  }

  terminate() {
    this.garden?.events.emit("_exit", {})
  }

  async action({
    garden,
    log,
    footerLog,
    args,
    opts,
  }: CommandParams<DevCommandArgs, DevCommandOpts>): Promise<CommandResult> {
    this.garden = garden
    this.server?.setGarden(garden)

    const graph = await garden.getConfigGraph({ log, emit: true })
    const modules = graph.getModules()

    const skipTests = opts["skip-tests"]

    if (modules.length === 0) {
      footerLog && footerLog.setState({ msg: "" })
      log.info({ msg: "No enabled modules found in project." })
      log.info({ msg: "Aborting..." })
      return {}
    }

    const localModeServiceNames = getMatchingServiceNames(opts["local-mode"], graph)

    const services = graph.getServices({ names: args.services })

    const devModeServiceNames = services
      .map((s) => s.name)
      // Since dev mode is implicit when using this command, we consider explicitly enabling local mode to
      // take precedence over dev mode.
      .filter((name) => !localModeServiceNames.includes(name))

    const initialTasks = await getDevCommandInitialTasks({
      garden,
      log,
      graph,
      modules,
      services,
      devModeServiceNames,
      localModeServiceNames,
      skipTests,
      forceDeploy: opts.force,
    })

    const results = await processActions({
      garden,
      graph,
      log,
      footerLog,
      modules,
      watch: true,
      initialTasks,
      skipWatch: getDevModeModules(devModeServiceNames, graph),
      changeHandler: async (updatedGraph: ConfigGraph, module: GardenModule) => {
        return getDevCommandWatchTasks({
          garden,
          log,
          updatedGraph,
          module,
          servicesWatched: devModeServiceNames,
          devModeServiceNames,
          localModeServiceNames,
          testNames: opts["test-names"],
          skipTests,
        })
      },
    })

    return handleProcessResults(footerLog, "dev", results)
  }
}

export async function getDevCommandInitialTasks({
  garden,
  log,
  graph,
  modules,
  services,
  devModeServiceNames,
  localModeServiceNames,
  skipTests,
  forceDeploy,
}: {
  garden: Garden
  log: LogEntry
  graph: ConfigGraph
  modules: GardenModule[]
  services: GardenService[]
  devModeServiceNames: string[]
  localModeServiceNames: string[]
  skipTests: boolean
  forceDeploy: boolean
}) {
  const moduleTasks = flatten(
    await Bluebird.map(modules, async (module) => {
      // Build the module (in case there are no tests, tasks or services here that need to be run)
      const buildTasks = await BuildTask.factory({
        garden,
        graph,
        log,
        module,
        force: false,
      })

      // Run all tests in module
      const testTasks = skipTests
        ? []
        : await getTestTasksFromModule({
            garden,
            graph,
            log,
            module,
            devModeServiceNames,
            localModeServiceNames,
            force: forceDeploy,
            forceBuild: false,
          })

      return [...buildTasks, ...testTasks]
    })
  )

  const serviceTasks = services
    .filter((s) => !s.disabled)
    .map(
      (service) =>
        new DeployTask({
          garden,
          log,
          graph,
          service,
          force: false,
          forceBuild: false,
          fromWatch: false,
          devModeServiceNames,
          localModeServiceNames,
        })
    )

  return [...moduleTasks, ...serviceTasks]
}

export async function getDevCommandWatchTasks({
  garden,
  log,
  updatedGraph,
  module,
  servicesWatched,
  devModeServiceNames,
  localModeServiceNames,
  testNames,
  skipTests,
}: {
  garden: Garden
  log: LogEntry
  updatedGraph: ConfigGraph
  module: GardenModule
  servicesWatched: string[]
  devModeServiceNames: string[]
  localModeServiceNames: string[]
  testNames: string[] | undefined
  skipTests: boolean
}) {
  const tasks = await getModuleWatchTasks({
    garden,
    log,
    graph: updatedGraph,
    module,
    servicesWatched,
    devModeServiceNames,
    localModeServiceNames,
  })

  if (!skipTests) {
    const testModules: GardenModule[] = updatedGraph.withDependantModules([module])
    tasks.push(
      ...flatten(
        await Bluebird.map(testModules, (m) =>
          getTestTasksFromModule({
            garden,
            log,
            module: m,
            graph: updatedGraph,
            filterNames: testNames,
            fromWatch: true,
            devModeServiceNames,
            localModeServiceNames,
          })
        )
      )
    )
  }

  return tasks
}

function getGreetingTime() {
  const m = moment()

  const currentHour = parseFloat(m.format("HH"))

  if (currentHour >= 17) {
    return "evening"
  } else if (currentHour >= 12) {
    return "afternoon"
  } else {
    return "morning"
  }
}
