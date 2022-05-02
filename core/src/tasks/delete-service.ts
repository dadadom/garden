/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { LogEntry } from "../logger/log-entry"
import { BaseActionTask, TaskType } from "./base"
import { ServiceStatus } from "../types/service"
import { Garden } from "../garden"
import { ConfigGraph } from "../graph/config-graph"
import { GraphResults, GraphResult } from "../task-graph"
import { DeployAction, isDeployAction } from "../actions/deploy"

export interface DeleteServiceTaskParams {
  garden: Garden
  graph: ConfigGraph
  action: DeployAction
  log: LogEntry
  /**
   * If true, the task will include delete service tasks for its dependants in its list of dependencies.
   */
  dependantsFirst?: boolean
  /**
   * If not provided, defaults to just `[service.name]`.
   */
  deleteDeployNames?: string[]
}

export class DeleteDeployTask extends BaseActionTask<DeployAction> {
  type: TaskType = "delete-service"
  concurrencyLimit = 10
  dependantsFirst: boolean
  deleteDeployNames: string[]

  constructor({ garden, graph, log, action, deleteDeployNames, dependantsFirst = false }: DeleteServiceTaskParams) {
    super({ garden, log, force: false, action, graph })
    this.dependantsFirst = dependantsFirst
    this.deleteDeployNames = deleteDeployNames || [action.name]
  }

  async resolveDependencies() {
    if (!this.dependantsFirst) {
      return []
    }

    // Note: We delete in _reverse_ dependency order, so we query for dependants
    const deps = this.graph.getDependants({
      kind: "deploy",
      name: this.getName(),
      recursive: false,
      filter: (depNode) => depNode.type === "deploy" && this.deleteDeployNames.includes(depNode.name),
    })

    return deps.filter(isDeployAction).map((action) => {
      return new DeleteDeployTask({
        garden: this.garden,
        graph: this.graph,
        log: this.log,
        action,
        deleteDeployNames: this.deleteDeployNames,
        dependantsFirst: true,
      })
    })
  }

  getName() {
    return this.action.name
  }

  getDescription() {
    return `deleting service ${this.action.description()})`
  }

  async process(): Promise<ServiceStatus> {
    const actions = await this.garden.getActionRouter()
    let status: ServiceStatus

    try {
      status = await actions.deploy.delete({ log: this.log, action: this.action, graph: this.graph })
    } catch (err) {
      this.log.setError()
      throw err
    }

    return status
  }
}

export function deletedServiceStatuses(results: GraphResults): { [serviceName: string]: ServiceStatus } {
  const deleted = <GraphResult[]>Object.values(results).filter((r) => r && r.type === "delete-service")
  const statuses = {}

  for (const res of deleted) {
    statuses[res.name] = res.output
  }

  return statuses
}
