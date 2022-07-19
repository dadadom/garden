/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import Bluebird from "bluebird"
import { find, flatten } from "lodash"
import dedent = require("dedent")
import minimatch from "minimatch"

import {
  Command,
  CommandParams,
  CommandResult,
  handleProcessResults,
  PrepareParams,
  ProcessCommandResult,
  processCommandResultSchema,
} from "./base"
import { processActions } from "../process"
import { GardenModule } from "../types/module"
import { getTestTasksFromModule, TestTask } from "../tasks/test"
import { printHeader } from "../logger/util"
import { startServer } from "../server/server"
import { StringsParameter, BooleanParameter } from "../cli/params"
import { deline } from "../util/string"
import { Garden } from "../garden"
import { ConfigGraph } from "../graph/config-graph"
import { getNames } from "../util/util"
import minimatch = require("minimatch")
import { isTestAction } from "../actions/test"

export const testArgs = {
  names: new StringsParameter({
    help: deline`
      The name(s) of the test(s) (or module names) to test (skip to run all tests in the project).
      Use comma as a separator to specify multiple modules.
    `,
  }),
}

export const testOpts = {
  "name": new StringsParameter({
    help: deline`
      DEPRECATED: you can now use globs in positional arguments.

      Only run tests with the specfied name (e.g. unit or integ).
      Accepts glob patterns (e.g. integ* would run both 'integ' and 'integration').
    `,
    alias: "n",
  }),
  "force": new BooleanParameter({
    help: "Force re-test of module(s).",
    alias: "f",
  }),
  "force-build": new BooleanParameter({ help: "Force rebuild of module(s)." }),
  "watch": new BooleanParameter({
    help: "Watch for changes in module(s) and auto-test.",
    alias: "w",
    cliOnly: true,
  }),
  "skip": new StringsParameter({
    help: deline`
      The name(s) of tests you'd like to skip. Accepts glob patterns
      (e.g. integ* would skip both 'integ' and 'integration'). Applied after the 'name' filter.
    `,
  }),
  "skip-dependencies": new BooleanParameter({
    help: deline`Don't deploy any services or run any tasks that the requested tests depend on.
    This can be useful e.g. when your stack has already been deployed, and you want to run tests with runtime
    dependencies without redeploying any service dependencies that may have changed since you last deployed.
    Warning: Take great care when using this option in CI, since Garden won't ensure that the runtime dependencies of
    your test suites are up to date when this option is used.`,
    alias: "no-deps",
  }),
  "skip-dependants": new BooleanParameter({
    help: deline`
      When using the modules argument, only run tests for those modules (and skip tests in other modules with
      dependencies on those modules).
    `,
  }),
}

type Args = typeof testArgs
type Opts = typeof testOpts

export class TestCommand extends Command<Args, Opts> {
  name = "test"
  help = "Run all or specified tests in the project."

  protected = true
  streamEvents = true

  description = dedent`
    Runs all or specified tests defined in the project. Also run builds and other dependencies,
    including deploys if needed.

    Optionally stays running and automatically re-runs tests if their sources
    (or their dependencies' sources) change, with the --watch/-w flag.

    Examples:

        garden test                   # run all tests in the project
        garden test my-test           # run the my-test Test action
        garden test my-module         # run all tests in the my-module module
        garden test *integ*           # run all tests with a name containing 'integ'
        garden test *unit,*lint       # run all tests called either 'unit' or 'lint' in the project
        garden test --force           # force tests to be re-run, even if they've already run successfully
        garden test --watch           # watch for changes to code
  `

  arguments = testArgs
  options = testOpts

  outputsSchema = () => processCommandResultSchema()

  private garden?: Garden

  printHeader({ headerLog }) {
    printHeader(headerLog, `Running tests`, "thermometer")
  }

  isPersistent({ opts }: PrepareParams<Args, Opts>) {
    return !!opts.watch
  }

  async prepare(params: PrepareParams<Args, Opts>) {
    if (this.isPersistent(params)) {
      this.server = await startServer({ log: params.footerLog })
    }
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
  }: CommandParams<Args, Opts>): Promise<CommandResult<ProcessCommandResult>> {
    this.garden = garden

    if (this.server) {
      this.server.setGarden(garden)
    }

    const graph = await garden.getConfigGraph({ log, emit: true })
    const skipDependants = opts["skip-dependants"]
    let modules: GardenModule[]

    if (args.names) {
      modules = skipDependants
        ? graph.getModules({ names: args.names })
        : graph.withDependantModules(graph.getModules({ names: args.names }))
    } else {
      modules = graph.getModules()
    }

    const filterNames = opts.name || []
    const force = opts.force
    const forceBuild = opts["force-build"]
    const skipRuntimeDependencies = opts["skip-dependencies"]
    const skipped = opts.skip || []

    const actions = getTestActions({ graph, modules, filterNames })

    const initialTasks = actions.map(
      (action) =>
        new TestTask({
          garden,
          graph,
          log,
          force,
          forceBuild,
          fromWatch: false,
          action,
          devModeServiceNames: [],
          localModeServiceNames: [],
          skipRuntimeDependencies,
        })
      )
    .filter(
      (testTask) =>
        skipped.length === 0 || !skipped.some((s) => minimatch(testTask.test.name.toLowerCase(), s.toLowerCase()))
    )

    const results = await processActions({
      garden,
      graph,
      log,
      footerLog,
      actions,
      initialTasks,
      watch: opts.watch,
      changeHandler: async (updatedGraph, action) => {
        if ()

        const dependants = updatedGraph.getDependants({ kind: action.kind, name: action.name }).filter(isTestAction)

        return flatten(
          await Bluebird.map([action, ...dependants], (action) =>
            getTestTasksFromModule({
              garden,
              log,
              graph: updatedGraph,
              action,
              filterNames,
              force,
              forceBuild,
              fromWatch: true,
              devModeServiceNames: [],
              localModeServiceNames: [],
            })
          )
        )
      },
    })

    return handleProcessResults(footerLog, "test", results)
  }
}

function getTestActions({
  graph,
  modules,
  filterNames,
}: {
  graph: ConfigGraph
  modules?: GardenModule[]
  filterNames?: string[]
}) {
  let tests = graph.getTests().filter((t) => !t.isDisabled())
  if (modules) {
    const moduleNames = getNames(modules)
    tests = tests.filter((t) => moduleNames.includes(t.moduleName()))
  }
  if (filterNames) {
    tests = tests.filter((t) => find(filterNames, (n: string) => minimatch(t.name, n)))
  }
  return tests
}
