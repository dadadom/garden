/*
 * Copyright (C) 2018-2021 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import Joi = require("@hapi/joi")
import chalk from "chalk"
import dedent = require("dedent")
import inquirer = require("inquirer")
import stripAnsi from "strip-ansi"
import { fromPairs, pickBy, size } from "lodash"

import { joi, joiIdentifierMap, joiStringMap } from "../config/common"
import { InternalError, RuntimeError, GardenBaseError } from "../exceptions"
import { Garden } from "../garden"
import { LogEntry } from "../logger/log-entry"
import { LoggerType } from "../logger/logger"
import { printFooter, renderMessageWithDivider } from "../logger/util"
import { ProcessResults } from "../process"
import { GraphResults, GraphResult } from "../task-graph"
import { RunResult } from "../types/plugin/base"
import { capitalize } from "lodash"
import { getDurationMsec, splitFirst } from "../util/util"
import { buildResultSchema, BuildResult } from "../types/plugin/module/build"
import { ServiceStatus, serviceStatusSchema } from "../types/service"
import { TestResult, testResultSchema } from "../types/plugin/module/getTestResult"
import { cliStyles, renderOptions, renderCommands, renderArguments } from "../cli/helpers"
import { GlobalOptions, ParameterValues, Parameters } from "../cli/params"
import { GardenServer } from "../server/server"

export interface CommandConstructor {
  new (parent?: CommandGroup): Command
}

export interface CommandResult<T = any> {
  result?: T
  restartRequired?: boolean
  errors?: GardenBaseError[]
}

export interface CommandParamsBase<T extends Parameters = {}, U extends Parameters = {}> {
  args: ParameterValues<T> & { _?: string[] }
  opts: ParameterValues<GlobalOptions & U>
}

export interface PrintHeaderParams<T extends Parameters = {}, U extends Parameters = {}>
  extends CommandParamsBase<T, U> {
  headerLog: LogEntry
}

export interface PrepareParams<T extends Parameters = {}, U extends Parameters = {}> extends CommandParamsBase<T, U> {
  headerLog: LogEntry
  footerLog: LogEntry
  log: LogEntry
}

export interface CommandParams<T extends Parameters = {}, U extends Parameters = {}> extends PrepareParams<T, U> {
  garden: Garden
  /**
   * Only use when running a workflow step command (in which case `true` should be passed).
   */
  isWorkflowStepCommand?: boolean
  taskSettings?: CommandTaskSettings
}

interface PrepareOutput {
  /**
   * Commands should set this to true if the command is long-running
   */
  persistent: boolean
  /**
   * Currently only used for the `dev` command.
   */
  taskSettings?: CommandTaskSettings
}

type DataCallback = (data: string) => void

export abstract class Command<T extends Parameters = {}, U extends Parameters = {}> {
  abstract name: string
  abstract help: string

  description?: string
  alias?: string

  arguments?: T
  options?: U

  outputsSchema?: () => Joi.ObjectSchema

  cliOnly: boolean = false
  hidden: boolean = false
  noProject: boolean = false
  protected: boolean = false
  workflows: boolean = false // Set to true to allow the command in workflow steps
  streamEvents: boolean = false // Set to true to stream events for the command
  streamLogEntries: boolean = false // Set to true to stream log entries for the command
  server: GardenServer | undefined = undefined

  subscribers: DataCallback[]
  terminated: boolean

  constructor(private parent?: CommandGroup) {
    this.subscribers = []
    this.terminated = false

    // Make sure arguments and options don't have overlapping key names.
    if (this.arguments && this.options) {
      for (const key of Object.keys(this.options)) {
        if (key in this.arguments) {
          const commandName = this.getFullName()

          throw new InternalError(`Key ${key} is defined in both options and arguments for command ${commandName}`, {
            commandName,
            key,
          })
        }
      }
    }

    // TODO: make sure required arguments don't follow optional ones
    // TODO: make sure arguments don't have default values
  }

  getKey() {
    return !!this.parent ? `${this.parent.getKey()}.${this.name}` : this.name
  }

  getFullName(): string {
    return !!this.parent ? `${this.parent.getFullName()} ${this.name}` : this.name
  }

  getPath(): string[] {
    return !!this.parent ? [...this.parent.getPath(), this.name] : [this.name]
  }

  /**
   * Returns all paths that this command should match, including all aliases and permutations of those.
   */
  getPaths(): string[][] {
    if (this.parent) {
      const parentPaths = this.parent.getPaths()

      if (this.alias) {
        return parentPaths.flatMap((parentPath) => [
          [...parentPath, this.name],
          [...parentPath, this.alias!],
        ])
      } else {
        return parentPaths.map((parentPath) => [...parentPath, this.name])
      }
    } else if (this.alias) {
      return [[this.name], [this.alias]]
    } else {
      return [[this.name]]
    }
  }

  getLoggerType(_: CommandParamsBase<T, U>): LoggerType {
    return "fancy"
  }

  describe() {
    const { name, help, description, cliOnly } = this

    return {
      name,
      fullName: this.getFullName(),
      help,
      description: description ? stripAnsi(description) : undefined,
      cliOnly,
      arguments: describeParameters(this.arguments),
      options: describeParameters(this.options),
      outputsSchema: this.outputsSchema,
      workflows: this.workflows,
    }
  }

  /**
   * Called by the CLI before the command's action is run, but is not called again
   * if the command restarts. Useful for commands in watch mode.
   */
  async prepare(_: PrepareParams<T, U>): Promise<PrepareOutput> {
    return { persistent: false }
  }

  /**
   * Called by e.g. the WebSocket server to terminate persistent commands.
   */
  terminate() {
    this.terminated = true
  }

  /**
   * Subscribe to any data emitted by commands via the .emit() method
   */
  subscribe(cb: (data: string) => void) {
    this.subscribers.push(cb)
  }

  /**
   * Emit data to all subscribers
   */
  emit(log: LogEntry, data: string) {
    for (const subscriber of this.subscribers) {
      // Ignore any errors here
      try {
        subscriber(data)
      } catch (err) {
        log.debug(`Error when calling subscriber on ${this.getFullName()} command: ${err.message}`)
      }
    }
  }

  abstract printHeader(params: PrintHeaderParams<T, U>): void

  // Note: Due to a current TS limitation (apparently covered by https://github.com/Microsoft/TypeScript/issues/7011),
  // subclass implementations need to explicitly set the types in the implemented function signature. So for now we
  // can't enforce the types of `args` and `opts` automatically at the abstract class level and have to specify
  // the types explicitly on the subclassed methods.
  abstract action(params: CommandParams<T, U>): Promise<CommandResult>

  /**
   * Called on all commands and checks if the command is protected.
   * If it's a protected command, the environment is "production" and the user hasn't specified the "--yes/-y" option
   * it asks for confirmation to proceed.
   *
   * @param {Garden} garden
   * @param {LogEntry} log
   * @param {GlobalOptions} opts
   * @returns {Promise<Boolean>}
   * @memberof Command
   */
  async isAllowedToRun(garden: Garden, log: LogEntry, opts: ParameterValues<GlobalOptions>): Promise<Boolean> {
    log.root.stop()
    if (!opts.yes && this.protected && garden.production) {
      const defaultMessage = chalk.yellow(dedent`
        Warning: you are trying to run "garden ${this.getFullName()}" against a production environment ([${
        garden.environmentName
      }])!
          Are you sure you want to continue? (run the command with the "--yes" flag to skip this check).

      `)
      const answer: any = await inquirer.prompt({
        name: "continue",
        message: defaultMessage,
        type: "confirm",
        default: false,
      })

      log.info("")

      return answer.continue
    }

    return true
  }

  renderHelp() {
    let out = this.description ? `${cliStyles.heading("DESCRIPTION")}\n\n${chalk.dim(this.description.trim())}\n\n` : ""

    out += `${cliStyles.heading("USAGE")}\n  garden ${this.getFullName()} `

    if (this.arguments) {
      out +=
        Object.entries(this.arguments)
          .map(([name, param]) => cliStyles.usagePositional(name, param.required))
          .join(" ") + " "
    }

    out += cliStyles.optionsPlaceholder()

    if (this.arguments) {
      const table = renderArguments(this.arguments)
      out += `\n\n${cliStyles.heading("ARGUMENTS")}\n${table}`
    }

    if (this.options) {
      const table = renderOptions(this.options)
      out += `\n\n${cliStyles.heading("OPTIONS")}\n${table}`
    }

    return out + "\n"
  }
}

export abstract class CommandGroup extends Command {
  abstract subCommands: CommandConstructor[]

  getSubCommands(): Command[] {
    return this.subCommands.flatMap((cls) => {
      const cmd = new cls(this)
      if (cmd instanceof CommandGroup) {
        return cmd.getSubCommands()
      } else {
        return [cmd]
      }
    })
  }

  printHeader() {}

  async action() {
    return {}
  }

  describe() {
    const description = super.describe()
    const subCommands = this.subCommands.map((S) => new S(this).describe())

    return {
      ...description,
      subCommands,
    }
  }

  renderHelp() {
    const commands = this.subCommands.map((c) => new c(this))

    return `
${cliStyles.heading("USAGE")}
  garden ${this.getFullName()} ${cliStyles.commandPlaceholder()} ${cliStyles.optionsPlaceholder()}

${cliStyles.heading("COMMANDS")}
${renderCommands(commands)}
`
  }
}

export function printResult({
  log,
  result,
  success,
  actionDescription,
}: {
  log: LogEntry
  result: string
  success: boolean
  actionDescription: string
}) {
  const prefix = success
    ? `${capitalize(actionDescription)} output:`
    : `${capitalize(actionDescription)} failed with error:`
  const msg = renderMessageWithDivider(prefix, result, !success)
  success ? log.info(chalk.white(msg)) : log.error(msg)
}

/**
 * Handles the command result and logging for commands that return a result of type RunResult. E.g.
 * the ``run service` command.
 */
export async function handleRunResult<T extends RunResult>({
  log,
  actionDescription,
  graphResults,
  result,
  interactive,
}: {
  log: LogEntry
  actionDescription: string
  graphResults: GraphResults
  result: T
  interactive: boolean
}) {
  if (!interactive && result.log) {
    printResult({ log, result: result.log, success: result.success, actionDescription })
  }

  if (!result.success) {
    const error = new RuntimeError(`${capitalize(actionDescription)} failed!`, {
      result,
    })
    return { errors: [error] }
  }

  if (!interactive) {
    printFooter(log)
  }

  const resultWithMetadata = {
    ...result,
    aborted: false,
    durationMsec: getDurationMsec(result.startedAt, result.completedAt),
    version: result.version,
  }

  return { result: { result: resultWithMetadata, graphResults } }
}

/**
 * Handles the command result and logging for commands the return a result of type TaskResult. E.g.
 * the `run task` and `run test` commands.
 */
export async function handleTaskResult({
  log,
  actionDescription,
  graphResults,
  key,
  interactive = false,
}: {
  log: LogEntry
  actionDescription: string
  graphResults: GraphResults
  key: string
  interactive?: boolean
}) {
  const result = graphResults[key]!

  // If there's an error, the task graph prints it
  if (!interactive && !result.error && result.output.log) {
    printResult({ log, result: result.output.log, success: true, actionDescription })
  }

  if (result.error) {
    const error = new RuntimeError(`${capitalize(actionDescription)} failed!`, {
      result,
    })
    return { errors: [error] }
  }

  printFooter(log)

  return { result: { result: prepareProcessResult(result), graphResults } }
}

/**
 * Determines which tasks (and with which settings) will be executed by a command.
 *
 * This applies both to the initial set of tasks that's run when a command starts (or immediately after a restart
 * when garden config changes), and to the set of tasks that's processed when module sources change.
 */
export interface CommandTaskSettings {
  forceBuild: boolean
  forceDeploy: boolean
  forceTest: boolean
  /**
   * `["*"]` means: include build tasks for all modules.
   * `[]` means: don't include build tasks for any modules (except as dependencies of other added tasks)
   */
  buildModuleNames: string[]
  /**
   * `["*"]` means: include deploy tasks for all services.
   * `[]` means: don't include deploy tasks for any services (except as dependencies of other added tasks)
   */
  deployServiceNames: string[]
  skipDeployServiceNames: string[]
  /**
   * `["*"]` means: include test tasks for all modules.
   * `[]` means: don't include test tasks for any modules.
   */
  testModuleNames: string[]
  /**
   * `["*"]` means: don't filter on test config name
   * `[]` is not allowed.
   */
  testConfigNames: string[] // E.g. from the `--name` option of the `test` command.
  /**
   * `["*"]` means: deploy all services indicated by `deployServiceNames` in dev mode.
   * `[]` means: don't deploy any service in dev mode.
   */
  devModeServiceNames: string[]
  /**
   * `["*"]` means: deploy all services indicated by `deployServiceNames` with hot reloading.
   * `[]` means: don't deploy any service with hot reloading.
   */
  hotReloadServiceNames: string[]
}

export function prepareTaskSettings(params: Partial<CommandTaskSettings>): CommandTaskSettings {
  const settings = {
    forceBuild: false,
    forceDeploy: false,
    forceTest: false,
    buildModuleNames: [],
    deployServiceNames: [],
    skipDeployServiceNames: [],
    testModuleNames: [],
    testConfigNames: [],
    devModeServiceNames: [],
    hotReloadServiceNames: [],
    ...params,
  }
  // console.log(`prepareTaskSettings: ${JSON.stringify(settings, null, 2)}`)
  return settings
}

export type ProcessResultMetadata = {
  aborted: boolean
  durationMsec?: number
  success: boolean
  error?: string
  version?: string
}

export interface ProcessCommandResult {
  builds: { [moduleName: string]: BuildResult & ProcessResultMetadata }
  deployments: { [serviceName: string]: ServiceStatus & ProcessResultMetadata }
  tests: { [testName: string]: TestResult & ProcessResultMetadata }
  graphResults: GraphResults
}

export const resultMetadataKeys = () => ({
  aborted: joi.boolean().description("Set to true if the build was not attempted, e.g. if a dependency build failed."),
  durationMsec: joi.number().integer().description("The duration of the build in msec, if applicable."),
  success: joi.boolean().required().description("Whether the build was succeessful."),
  error: joi.string().description("An error message, if the build failed."),
  version: joi.string().description("The version of the module, service, task or test."),
})

export const graphResultsSchema = () =>
  joi
    .object()
    .description(
      "A map of all raw graph results. Avoid using this programmatically if you can, and use more structured keys instead."
    )
    .meta({ keyPlaceholder: "<key>" })

export const processCommandResultSchema = () =>
  joi.object().keys({
    builds: joiIdentifierMap(buildResultSchema().keys(resultMetadataKeys()))
      .description(
        "A map of all modules that were built (or builds scheduled/attempted for) and information about the builds."
      )
      .meta({ keyPlaceholder: "<module name>" }),
    deployments: joiIdentifierMap(serviceStatusSchema().keys(resultMetadataKeys()))
      .description(
        "A map of all services that were deployed (or deployment scheduled/attempted for) and the service status."
      )
      .meta({ keyPlaceholder: "<service name>" }),
    tests: joiStringMap(testResultSchema().keys(resultMetadataKeys()))
      .description("A map of all tests that were run (or scheduled/attempted) and the test results.")
      .meta({ keyPlaceholder: "<test name>" }),
    graphResults: graphResultsSchema(),
  })

/**
 * Handles the command result and logging for commands the return results of type ProcessResults.
 * This applies to commands that can run in watch mode.
 */
export async function handleProcessResults(
  log: LogEntry,
  taskType: string,
  results: ProcessResults
): Promise<CommandResult<ProcessCommandResult>> {
  const graphResults = results.taskResults

  const result = {
    builds: prepareProcessResults("build", graphResults),
    deployments: prepareProcessResults("deploy", graphResults),
    tests: prepareProcessResults("test", graphResults),
    graphResults,
  }

  const failed = pickBy(results.taskResults, (r) => r && r.error)
  const failedCount = size(failed)

  if (failedCount > 0) {
    const error = new RuntimeError(`${failedCount} ${taskType} task(s) failed!`, { results: failed })
    return { result, errors: [error], restartRequired: false }
  }

  if (!results.restartRequired) {
    printFooter(log)
  }
  return {
    result,
    restartRequired: results.restartRequired,
  }
}

/**
 * Extracts structured results for builds, deploys or tests from TaskGraph results, suitable for command output.
 */
export function prepareProcessResults(taskType: string, graphResults: GraphResults) {
  const graphBuildResults = Object.entries(graphResults).filter(([name, _]) => name.split(".")[0] === taskType)

  return fromPairs(
    graphBuildResults.map(([name, graphResult]) => {
      return [splitFirst(name, ".")[1], prepareProcessResult(graphResult)]
    })
  )
}

function prepareProcessResult(graphResult: GraphResult | null) {
  return {
    ...(graphResult?.output || {}),
    aborted: !graphResult,
    durationMsec:
      graphResult?.startedAt &&
      graphResult?.completedAt &&
      getDurationMsec(graphResult?.startedAt, graphResult?.completedAt),
    error: graphResult?.error?.message,
    success: !!graphResult && !graphResult.error,
    version: graphResult?.output?.version || graphResult?.version,
  }
}

export function describeParameters(args?: Parameters) {
  if (!args) {
    return
  }
  return Object.entries(args)
    .filter(([_, arg]) => !arg.hidden)
    .map(([argName, arg]) => ({
      name: argName,
      usageName: arg.required ? `<${argName}>` : `[${argName}]`,
      ...arg,
      help: stripAnsi(arg.help),
    }))
}
