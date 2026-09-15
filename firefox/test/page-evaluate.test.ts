import { test } from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { evaluateInPage, type UserScriptExecutor } from "../src/background/page-evaluate.js";

test("page evaluation compiles without eval, preserves globals/arguments, and awaits promises", async () => {
  const context = vm.createContext({ document: { title: "CSP page" }, count: 0 }, {
    codeGeneration: { strings: false, wasm: false },
  });
  const api: UserScriptExecutor = { execute: async (injection) => {
    assert.deepEqual(injection.target, { tabId: 7, frameIds: [2] });
    assert.equal(injection.world, "MAIN");
    try {
      return [{ frameId: 2, result: await vm.runInContext(injection.js[0].code, context) }];
    } catch (error) {
      return [{ frameId: 2, error }];
    }
  } };
  Object.assign(globalThis, { browser: { userScripts: api } });
  const run = (expression: string, arg?: unknown) => evaluateInPage(7, 2, expression, arg, 1000);
  assert.equal((await run("document.title")).value, "CSP page");
  assert.equal((await run("async (arg) => arg.text + document.title", { text: "hello " })).value, "hello CSP page");
  assert.equal((await run("arg => Object.hasOwn(arg, '__proto__')", JSON.parse('{"__proto__":42}'))).value, true);
  assert.equal((await run("arg => arg === undefined")).value, true);
  assert.equal((await run("1 + 2 // comment")).value, 3);
  assert.equal((await run("undefined")).value, null);
  assert.match((await run("new Function('return 1')()")).error!, /Code generation from strings disallowed/);
  assert.match((await run("(() => { count++; throw new EvalError('blocked by CSP'); })()")).error!, /blocked by CSP/);
  assert.equal(context.count, 1, "throwing scripts are never retried in another world");
  assert.match((await run("(() =>")).error!, /SyntaxError/);
  assert.match((await run("noSuchGlobal()")).error!, /ReferenceError/);
  assert.match(String((await run("({ self: null, toJSON() { throw Error('cycle'); } })")).value), /unserializable/);
});

test("missing permission, frame loss, API errors and timeouts are actionable and never retried", async () => {
  Object.assign(globalThis, { browser: {} });
  await assert.rejects(evaluateInPage(1, 0, "1", undefined, 100), /page evaluation permission request/);
  await assert.rejects(evaluateInPage(1, 0, "", undefined, 100), /non-empty expression/);
  Object.assign(globalThis, { browser: { userScripts: { execute: async () => [] } } });
  await assert.rejects(evaluateInPage(1, 0, "1", undefined, 100), /frame disappeared/);
  let calls = 0;
  Object.assign(globalThis, { browser: { userScripts: { execute: () => {
    calls++;
    return new Promise(() => {});
  } } } });
  await assert.rejects(evaluateInPage(1, 0, "1", undefined, 10), /may still be running/);
  assert.equal(calls, 1);
  Object.assign(globalThis, { browser: { userScripts: { execute: async () => { throw Error("Missing host permission"); } } } });
  await assert.rejects(evaluateInPage(1, 0, "1", undefined, 100), /Missing host permission/);
});
