import { canonicalJson, DevChestraError, err, ok, type Result } from "@devchestra/core";
import {
  type CompiledExpression,
  compileExpression,
  type EvaluateOptions,
  evaluate,
} from "./expression.js";
import type { Issue } from "./types.js";

export type TemplatePart =
  | { readonly kind: "literal"; readonly text: string }
  | { readonly kind: "expression"; readonly source: string; readonly compiled: CompiledExpression };

export interface CompiledTemplate {
  readonly source: string;
  readonly parts: readonly TemplatePart[];
  readonly shell: boolean;
}

export interface CompileTemplateOptions {
  /** Enforce conservative shell placeholder-context rules. */
  shell?: boolean;
}

export interface RenderOptions extends EvaluateOptions {
  /** Quote every substituted value with POSIX single-quote escaping. */
  shell?: boolean;
}

export interface RenderedTemplate {
  text: string;
  warnings: Issue[];
}

function templateError(message: string): DevChestraError {
  return new DevChestraError("E_EXPR", message);
}

function quotePosix(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function assertShellTemplate(parts: readonly TemplatePart[]): void {
  let quote: "none" | "single" | "double" | "backtick" = "none";
  let escaped = false;
  let comment = false;
  let last: string | undefined;
  let lastWasEscaped = false;
  const substitutions: string[] = [];

  const fail = (message: string): never => {
    throw templateError(`Unsafe shell template: ${message}`);
  };

  for (const part of parts) {
    if (part.kind === "expression") {
      if (comment) {
        fail(
          `placeholder {{ ${part.source} }} is inside a shell comment. A substituted value containing a newline could end the comment and run later lines.`,
        );
      }
      if (escaped) {
        fail(
          `placeholder {{ ${part.source} }} follows a trailing backslash; the generated quoting would be escaped. Add a space or remove the backslash.`,
        );
      }
      if (quote !== "none") {
        fail(
          `placeholder {{ ${part.source} }} is inside ${quote} quotes. Move it outside quotes; DevChestra only supports unquoted placeholder contexts.`,
        );
      }
      if (substitutions.length > 0) {
        fail(
          `placeholder {{ ${part.source} }} is inside a command or parameter substitution; this context is not supported.`,
        );
      }
      if (last === "$" && !lastWasEscaped) {
        fail(
          "a placeholder cannot follow '$' (ANSI-C quoting/expansion context is not supported).",
        );
      }
      last = undefined;
      lastWasEscaped = false;
      continue;
    }

    const text = part.text;
    for (let i = 0; i < text.length; i += 1) {
      const char = text[i];
      if (char === undefined) continue;
      if (comment) {
        if (char === "\n") comment = false;
        last = char;
        lastWasEscaped = false;
        continue;
      }
      if (quote === "single") {
        if (char === "'") quote = "none";
        last = char;
        lastWasEscaped = false;
        continue;
      }
      if (escaped) {
        escaped = false;
        last = char;
        lastWasEscaped = true;
        continue;
      }
      if (char === "\\") {
        escaped = true;
        last = char;
        lastWasEscaped = false;
        continue;
      }
      if (quote === "double") {
        if (char === '"') quote = "none";
        last = char;
        lastWasEscaped = false;
        continue;
      }
      if (quote === "backtick") {
        if (char === "`") quote = "none";
        last = char;
        lastWasEscaped = false;
        continue;
      }

      if (char === "#" && substitutions.length === 0) {
        comment = true;
      } else if (char === "'") {
        quote = "single";
      } else if (char === '"') {
        quote = "double";
      } else if (char === "`") {
        quote = "backtick";
      } else if (char === "<" && text[i + 1] === "<") {
        fail("heredocs and here-strings are not supported in shell templates.");
      } else if (char === "$" && text[i + 1] === "(") {
        substitutions.push("(");
        i += 1;
      } else if (char === "$" && text[i + 1] === "{") {
        substitutions.push("{");
        i += 1;
      } else if (substitutions.length > 0) {
        const top = substitutions[substitutions.length - 1];
        if (char === "(") substitutions.push("(");
        else if (char === ")" && top === "(") substitutions.pop();
        else if (char === "{" && top === "{") substitutions.push("{");
        else if (char === "}" && top === "{") substitutions.pop();
      }
      last = char;
      lastWasEscaped = false;
    }
  }

  if (quote !== "none") {
    fail(`unclosed ${quote} quote.`);
  }
  if (substitutions.length > 0) {
    fail("unclosed command or parameter substitution.");
  }
}

/**
 * Parse {{ expression }} template parts. Escaped `\{{` becomes a literal `{{`.
 * Raw {{{ ... }}} substitution is rejected in P1. With shell:true, placeholders
 * are only accepted in unquoted lexical context (no quotes, backticks,
 * substitutions or heredocs).
 */
export function compileTemplate(
  source: string,
  options: CompileTemplateOptions = {},
): Result<CompiledTemplate, DevChestraError> {
  const parts: TemplatePart[] = [];
  let literal = "";
  const flush = (): void => {
    if (literal !== "") {
      parts.push({ kind: "literal", text: literal });
      literal = "";
    }
  };

  let i = 0;
  while (i < source.length) {
    if (source.startsWith("\\{{", i)) {
      literal += "{{";
      i += 3;
      continue;
    }
    if (source.startsWith("{{{", i)) {
      return err(
        templateError(
          "Raw {{{ ... }}} substitution is not supported in P1. Use {{ ... }} (shell values are quoted) and require trust before raw insertion is added.",
        ),
      );
    }
    if (source.startsWith("{{", i)) {
      const end = source.indexOf("}}", i + 2);
      if (end < 0) {
        return err(templateError("Template placeholder is missing a closing '}}'"));
      }
      const expressionSource = source.slice(i + 2, end).trim();
      flush();
      const compiled = compileExpression(expressionSource);
      if (!compiled.ok) return compiled;
      parts.push({ kind: "expression", source: expressionSource, compiled: compiled.value });
      i = end + 2;
      continue;
    }
    literal += source[i];
    i += 1;
  }
  flush();

  const shell = options.shell === true;
  if (shell) {
    try {
      assertShellTemplate(parts);
    } catch (error) {
      return err(error instanceof DevChestraError ? error : templateError(String(error)));
    }
  }
  return ok({ source, parts, shell });
}

/** Render a template, evaluating each expression in the supplied scope. */
export async function renderTemplate(
  template: string | CompiledTemplate,
  scope: Readonly<Record<string, unknown>>,
  options: RenderOptions = {},
): Promise<Result<RenderedTemplate, DevChestraError>> {
  const shell = options.shell === true;
  let compiled: CompiledTemplate;
  if (typeof template === "string") {
    const result = compileTemplate(template, { shell });
    if (!result.ok) return result;
    compiled = result.value;
  } else {
    compiled = template;
    if (shell && !compiled.shell) {
      try {
        assertShellTemplate(compiled.parts);
      } catch (error) {
        return err(error instanceof DevChestraError ? error : templateError(String(error)));
      }
    }
  }

  let text = "";
  const warnings: Issue[] = [];
  for (const part of compiled.parts) {
    if (part.kind === "literal") {
      text += part.text;
      continue;
    }
    const evaluated = await evaluate(part.compiled, scope, {
      ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
      ...(options.executor === undefined ? {} : { executor: options.executor }),
    });
    if (!evaluated.ok) return evaluated;
    let value: string;
    if (evaluated.value === null) {
      warnings.push({
        severity: "warning",
        code: "W_TEMPLATE_MISSING",
        message: `Template expression '{{ ${part.source} }}' resolved to null or missing; inserted an empty string.`,
      });
      value = "";
    } else if (typeof evaluated.value === "string") {
      value = evaluated.value;
    } else {
      value = canonicalJson(evaluated.value);
    }
    text += shell ? quotePosix(value) : value;
  }
  return ok({ text, warnings });
}
