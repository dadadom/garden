/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { dedent } from "../../../util/string"
import { artifactsPathSchema, PluginTestActionParamsBase } from "../../../plugin/base"
import { RuntimeContext } from "../../../runtime-context"
import { TestActionSpec } from "../../../actions/test"
import { runBuildBaseSchema } from "../build/run"
import { joi } from "../../../config/common"
import { testResultSchema } from "../../../types/test"

export interface TestModuleParams<T extends TestActionSpec = TestActionSpec> extends PluginTestActionParamsBase<T> {
  artifactsPath: string
  interactive: boolean
  runtimeContext: RuntimeContext
  silent: boolean
}

export const testModule = () => ({
  description: dedent`
    Run the Test action.

    This should complete the test run and return the logs from the test run, and signal whether the tests completed successfully.

    It should also store the test results and provide the accompanying \`getTestResult\` handler, so that the same version does not need to be tested multiple times.
  `,
  paramsSchema: runBuildBaseSchema().keys({
    artifactsPath: artifactsPathSchema(),
    silent: joi.boolean().description("Set to true if no log output should be emitted during execution"),
  }),
  resultSchema: testResultSchema(),
})