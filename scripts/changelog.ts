#!/usr/bin/env ts-node
/*
 * Copyright (C) 2018-2023 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import execa from "execa"
import { resolve } from "path"

const gardenRoot = resolve(__dirname, "..")

export async function getChangelog(curReleaseTag: string) {
  try {
    return (
      await execa(
        "git-chglog",
        ["--tag-filter-pattern", "^\\d+\\.\\d+\\.\\d+$", "--sort", "semver", `${curReleaseTag}..${curReleaseTag}`],
        { cwd: gardenRoot }
      )
    ).stdout
  } catch (err) {
    throw new Error(`Error generating changelog: ${err}`)
  }
}
