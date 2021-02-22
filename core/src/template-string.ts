/*
 * Copyright (C) 2018-2020 Garden Technologies, Inc. <info@garden.io>
 *
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

import { GardenBaseError, ConfigurationError } from "./exceptions"
import {
  ConfigContext,
  ContextResolveOpts,
  ScanContext,
  ContextResolveOutput,
  ContextKeySegment,
} from "./config/template-contexts/base"
import { difference, uniq, isPlainObject, isNumber } from "lodash"
import { Primitive, StringMap, isPrimitive, objectSpreadKey } from "./config/common"
import { profile } from "./util/profiling"
import { dedent, deline, truncate } from "./util/string"
import { isArray } from "util"
import { ObjectWithName } from "./util/util"
import { LogEntry } from "./logger/log-entry"
import { ModuleConfigContext } from "./config/template-contexts/module"

export type StringOrStringPromise = Promise<string> | string

const missingKeyExceptionType = "template-string-missing-key"
const passthroughExceptionType = "template-string-passthrough"
const escapePrefix = "$${"

class TemplateStringError extends GardenBaseError {
  type = "template-string"
}

export class TemplateStringMissingKeyException extends GardenBaseError {
  type = missingKeyExceptionType
}

export class TemplateStringPassthroughException extends GardenBaseError {
  type = passthroughExceptionType
}

let _parser: any

function getParser() {
  if (!_parser) {
    _parser = require("./template-string-parser")
  }

  return _parser
}

interface ResolvedClause extends ContextResolveOutput {
  block?: "if" | "else" | "else if" | "endif"
  _error?: Error
}

interface ConditionalTree {
  type: "root" | "if" | "if" | "else" | "value"
  value?: any
  children: ConditionalTree[]
  parent?: ConditionalTree
}

function getValue(v: Primitive | undefined | ResolvedClause) {
  return isPlainObject(v) ? (<ResolvedClause>v).resolved : v
}

/**
 * Parse and resolve a templated string, with the given context. The template format is similar to native JS templated
 * strings but only supports simple lookups from the given context, e.g. "prefix-${nested.key}-suffix", and not
 * arbitrary JS code.
 *
 * The context should be a ConfigContext instance. The optional `stack` parameter is used to detect circular
 * dependencies when resolving context variables.
 */
export function resolveTemplateString(string: string, context: ConfigContext, opts: ContextResolveOpts = {}): any {
  if (!string) {
    return string
  }

  const parser = getParser()
  try {
    const parsed = parser.parse(string, {
      getKey: (key: string[], resolveOpts?: ContextResolveOpts) => {
        return context.resolve({ key, nodePath: [], opts: { ...opts, ...(resolveOpts || {}) } })
      },
      getValue,
      resolveNested: (nested: string) => resolveTemplateString(nested, context, opts),
      buildBinaryExpression,
      buildLogicalExpression,
      isArray,
      ConfigurationError,
      TemplateStringError,
      missingKeyExceptionType,
      passthroughExceptionType,
      allowPartial: !!opts.allowPartial,
      unescape: !!opts.unescape,
      escapePrefix,
      optionalSuffix: "}?",
      isPlainObject,
      isPrimitive,
    })

    const outputs: ResolvedClause[] = parsed.map((p: any) => {
      return isPlainObject(p) ? p : { resolved: getValue(p) }
    })

    // We need to manually propagate errors in the parser, so we catch them here
    for (const r of outputs) {
      if (r && r["_error"]) {
        throw r["_error"]
      }
    }

    // Use value directly if there is only one (or no) value in the output.
    let resolved: any = outputs[0]?.resolved

    if (outputs.length > 1) {
      // Assemble the parts into a conditional tree
      const tree: ConditionalTree = {
        type: "root",
        children: [],
      }
      let currentNode = tree

      for (const part of outputs) {
        if (part.block === "if") {
          const node: ConditionalTree = {
            type: "if",
            value: !!part.resolved,
            children: [],
            parent: currentNode,
          }
          currentNode.children.push(node)
          currentNode = node
        } else if (part.block === "else") {
          if (currentNode.type !== "if") {
            throw new TemplateStringError("Found ${else} block without a preceding ${if...} block.", {})
          }
          const node: ConditionalTree = {
            type: "else",
            value: !currentNode.value,
            children: [],
            parent: currentNode.parent,
          }
          currentNode.parent!.children.push(node)
          currentNode = node
        } else if (part.block === "endif") {
          if (currentNode.type === "if" || currentNode.type === "else") {
            currentNode = currentNode.parent!
          } else {
            throw new TemplateStringError("Found ${endif} block without a preceding ${if...} block.", {})
          }
        } else {
          const v = getValue(part)

          currentNode.children.push({
            type: "value",
            value: v === null ? "null" : v,
            children: [],
          })
        }
      }

      if (currentNode.type === "if" || currentNode.type === "else") {
        throw new TemplateStringError("Missing ${endif} after ${if ...} block.", {})
      }

      // Walk down tree and resolve the output string
      resolved = ""

      function resolveTree(node: ConditionalTree) {
        if (node.type === "value" && node.value !== undefined) {
          resolved += node.value
        } else if (node.type === "root" || ((node.type === "if" || node.type === "else") && !!node.value)) {
          for (const child of node.children) {
            resolveTree(child)
          }
        }
      }

      resolveTree(tree)
    }

    return resolved
  } catch (err) {
    const prefix = `Invalid template string (${truncate(string, 35).replace(/\n/g, "\\n")}): `
    const message = err.message.startsWith(prefix) ? err.message : prefix + err.message

    throw new TemplateStringError(message, {
      err,
    })
  }
}

/**
 * Recursively parses and resolves all templated strings in the given object.
 */
export const resolveTemplateStrings = profile(function $resolveTemplateStrings<T>(
  value: T,
  context: ConfigContext,
  opts: ContextResolveOpts = {}
): T {
  if (typeof value === "string") {
    return <T>resolveTemplateString(value, context, opts)
  } else if (isArray(value)) {
    return <T>(<unknown>value.map((v) => resolveTemplateStrings(v, context, opts)))
  } else if (isPlainObject(value)) {
    // Resolve $merge keys, depth-first, leaves-first
    let output = {}

    for (const [k, v] of Object.entries(value)) {
      const resolved = resolveTemplateStrings(v, context, opts)

      if (k === objectSpreadKey) {
        if (isPlainObject(resolved)) {
          output = { ...output, ...resolved }
        } else if (opts.allowPartial) {
          output[k] = resolved
        } else {
          throw new ConfigurationError(
            `Value of ${objectSpreadKey} key must be (or resolve to) a mapping object (got ${typeof resolved})`,
            {
              value,
              resolved,
            }
          )
        }
      } else {
        output[k] = resolved
      }
    }

    return <T>output
  } else {
    return <T>value
  }
})

/**
 * Scans for all template strings in the given object and lists the referenced keys.
 */
export function collectTemplateReferences<T extends object>(obj: T): ContextKeySegment[][] {
  const context = new ScanContext()
  resolveTemplateStrings(obj, context, { allowPartial: true })
  return uniq(context.foundKeys.entries()).sort()
}

export function getRuntimeTemplateReferences<T extends object>(obj: T) {
  const refs = collectTemplateReferences(obj)
  return refs.filter((ref) => ref[0] === "runtime")
}

export function getModuleTemplateReferences<T extends object>(obj: T, context: ModuleConfigContext) {
  const refs = collectTemplateReferences(obj)
  const moduleNames = refs.filter((ref) => ref[0] === "modules" && ref.length > 1)
  // Resolve template strings in name refs. This would ideally be done ahead of this function, but is currently
  // necessary to resolve templated module name references in ModuleTemplates.
  return resolveTemplateStrings(moduleNames, context)
}

/**
 * Gathers secret references in configs and throws an error if one or more referenced secrets isn't present (or has
 * blank values) in the provided secrets map.
 *
 * Prefix should be e.g. "Module" or "Provider" (used when generating error messages).
 *
 * TODO: We've disabled this for now. Re-introudce once we've removed get config command call from GE!
 */
export function throwOnMissingSecretKeys(
  configs: ObjectWithName[],
  secrets: StringMap,
  prefix: string,
  log?: LogEntry
) {
  const allMissing: [string, ContextKeySegment[]][] = [] // [[key, missing keys]]
  for (const config of configs) {
    const missing = detectMissingSecretKeys(config, secrets)
    if (missing.length > 0) {
      allMissing.push([config.name, missing])
    }
  }

  if (allMissing.length === 0) {
    return
  }

  const descriptions = allMissing.map(([key, missing]) => `${prefix} ${key}: ${missing.join(", ")}`)
  /**
   * Secret keys with empty values should have resulted in an error by this point, but we filter on keys with
   * values for good measure.
   */
  const loadedKeys = Object.entries(secrets)
    .filter(([_key, value]) => value)
    .map(([key, _value]) => key)
  let footer: string
  if (loadedKeys.length === 0) {
    footer = deline`
      Note: No secrets have been loaded. If you have defined secrets for the current project and environment in Garden
      Cloud, this may indicate a problem with your configuration.
    `
  } else {
    footer = `Secret keys with loaded values: ${loadedKeys.join(", ")}`
  }
  const errMsg = dedent`
    The following secret names were referenced in configuration, but are missing from the secrets loaded remotely:

    ${descriptions.join("\n\n")}

    ${footer}
  `
  if (log) {
    log.silly(errMsg)
  }
  // throw new ConfigurationError(errMsg, {
  //   loadedSecretKeys: loadedKeys,
  //   missingSecretKeys: uniq(flatten(allMissing.map(([_key, missing]) => missing))),
  // })
}

/**
 * Collects template references to secrets in obj, and returns an array of any secret keys referenced in it that
 * aren't present (or have blank values) in the provided secrets map.
 */
export function detectMissingSecretKeys<T extends object>(obj: T, secrets: StringMap): ContextKeySegment[] {
  const referencedKeys = collectTemplateReferences(obj)
    .filter((ref) => ref[0] === "secrets")
    .map((ref) => ref[1])
  /**
   * Secret keys with empty values should have resulted in an error by this point, but we filter on keys with
   * values for good measure.
   */
  const keysWithValues = Object.entries(secrets)
    .filter(([_key, value]) => value)
    .map(([key, _value]) => key)
  const missingKeys = difference(referencedKeys, keysWithValues)
  return missingKeys.sort()
}

function buildBinaryExpression(head: any, tail: any) {
  return tail.reduce((result: any, element: any) => {
    const operator = element[1]
    const leftRes = result
    const rightRes = element[3]

    // We need to manually handle and propagate errors because the parser doesn't support promises
    if (leftRes && leftRes._error) {
      return leftRes
    }
    if (rightRes && rightRes._error) {
      return rightRes
    }

    const left = getValue(leftRes)
    const right = getValue(rightRes)

    // Disallow undefined values for comparisons
    if (left === undefined || right === undefined) {
      const message = [leftRes, rightRes]
        .map((res) => res.message)
        .filter(Boolean)
        .join(" ")
      const err = new TemplateStringError(message || "Could not resolve one or more keys.", {
        left,
        right,
        operator,
      })
      return { _error: err }
    }

    if (operator === "==") {
      return left === right
    }
    if (operator === "!=") {
      return left !== right
    }

    if (operator === "+") {
      if (isNumber(left) && isNumber(right)) {
        return left + right
      } else if (isArray(left) && isArray(right)) {
        return left.concat(right)
      } else {
        const err = new TemplateStringError(
          `Both terms need to be either arrays or numbers for + operator (got ${typeof left} and ${typeof right}).`,
          { left, right, operator }
        )
        return { _error: err }
      }
    }

    // All other operators require numbers to make sense (we're not gonna allow random JS weirdness)
    if (!isNumber(left) || !isNumber(right)) {
      const err = new TemplateStringError(
        `Both terms need to be numbers for ${operator} operator (got ${typeof left} and ${typeof right}).`,
        { left, right, operator }
      )
      return { _error: err }
    }

    switch (operator) {
      case "*":
        return left * right
      case "/":
        return left / right
      case "%":
        return left % right
      case "-":
        return left - right
      case "<=":
        return left <= right
      case ">=":
        return left >= right
      case "<":
        return left < right
      case ">":
        return left > right
      default:
        const err = new TemplateStringError("Unrecognized operator: " + operator, { operator })
        return { _error: err }
    }
  }, head)
}

function buildLogicalExpression(head: any, tail: any) {
  return tail.reduce((result: any, element: any) => {
    const operator = element[1]
    const leftRes = result
    const rightRes = element[3]

    // We need to manually handle and propagate errors because the parser doesn't support promises
    if (leftRes && leftRes._error) {
      return leftRes
    }
    if (rightRes && rightRes._error) {
      return rightRes
    }

    const left = getValue(leftRes)

    switch (operator) {
      case "&&":
        return !left ? leftRes : rightRes
      case "||":
        return left ? leftRes : rightRes
      default:
        const err = new TemplateStringError("Unrecognized operator: " + operator, { operator })
        return { _error: err }
    }
  }, head)
}
