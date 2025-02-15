/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { mapKeys, mapValues, pickBy, omit } from "lodash"
import type { GraphResults } from "../graph/results"
import type { DeployStatus } from "../plugin/handlers/Deploy/get-status"
import { splitLast } from "../util/string"

export function getDeployStatuses(dependencyResults: GraphResults): { [name: string]: DeployStatus } {
  const deployResults = pickBy(dependencyResults.getMap(), (r) => r && r.type === "deploy")
  const statuses = mapValues(deployResults, (r) => omit(r!.result, "version") as DeployStatus)
  return mapKeys(statuses, (_, key) => splitLast(key, ".")[1])
}
