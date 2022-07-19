/*
 * Copyright (C) 2018-2022 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { readFileSync } from "fs"
import { resolve } from "path"
import handlebars = require("handlebars")
import { joi } from "../config/common"
import { ModuleReferenceContext } from "../config/template-contexts/module"
import { renderConfigReference, renderTemplateStringReference, TEMPLATES_DIR } from "./config"
import { ActionTypeDefinition } from "../plugin/action-types"
import { buildActionConfig } from "../actions/build"
import { deployActionConfig } from "../actions/deploy"
import { runActionConfig } from "../actions/run"
import { testActionConfig } from "../actions/test"
import titleize = require("titleize")

/**
 * Generates the action type reference from the action-type.hbs template.
 * The reference includes the rendered output from the config-partial.hbs template.
 */
export function renderActionTypeReference(kind: string, name: string, desc: ActionTypeDefinition<any>) {
  let { schema, docs } = desc

  const baseSchemas = {
    build: buildActionConfig(),
    deploy: deployActionConfig(),
    run: runActionConfig(),
    test: testActionConfig(),
  }

  const fullSchema = baseSchemas[kind].keys({ spec: schema })

  const templatePath = resolve(TEMPLATES_DIR, "action-type.hbs")
  const { markdownReference, yaml } = renderConfigReference(fullSchema)

  const outputsSchema = desc.outputsSchema || joi.object()

  const outputsReference = renderTemplateStringReference({
    schema: ModuleReferenceContext.getSchema().keys({
      outputs: outputsSchema.required(),
    }),
    prefix: `actions.${kind}`,
    placeholder: "<name>",
    exampleName: "my-" + kind,
  })

  const frontmatterTitle = `\`${name}\` ${titleize(kind)}`
  const template = handlebars.compile(readFileSync(templatePath).toString())
  return template({
    kind,
    frontmatterTitle,
    name,
    docs,
    markdownReference,
    yaml,
    hasOutputs: outputsReference,
    outputsReference,
  })
}
