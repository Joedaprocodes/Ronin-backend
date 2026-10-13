import { test } from "node:test";
import assert from "node:assert/strict";
import { renderTemplate, firstName } from "../src/broadcasts/render.js";

test("firstName returns the first whitespace-delimited word", () => {
  assert.equal(firstName("Ada Lovelace"), "Ada");
  assert.equal(firstName("  Grace   Brewster   Hopper "), "Grace");
  assert.equal(firstName("Prince"), "Prince");
  assert.equal(firstName(""), "");
  assert.equal(firstName("   "), "");
  assert.equal(firstName(null), "");
  assert.equal(firstName(undefined), "");
});

test("renderTemplate expands {{full_name}} and {{name}} from the contact name", () => {
  const out = renderTemplate("Hi {{full_name}} — or {{name}}?", {
    name: "Ada Lovelace",
    phone: "+2348000000000",
  });
  assert.equal(out, "Hi Ada Lovelace — or Ada?");
});

test("renderTemplate matching is case-insensitive and whitespace tolerant", () => {
  const out = renderTemplate("{{FULL_NAME}}/{{ name }}/{{  Full_Name  }}", {
    name: "Grace Hopper",
  });
  assert.equal(out, "Grace Hopper/Grace/Grace Hopper");
});

test("renderTemplate falls back to fallbackName, then phone, when the name is empty", () => {
  assert.equal(
    renderTemplate("Hey {{name}}!", { name: "", fallbackName: "Friend", phone: "+2348000000000" }),
    "Hey Friend!"
  );
  assert.equal(
    renderTemplate("Hey {{full_name}}!", { name: "   ", fallbackName: "", phone: "+2348000000000" }),
    "Hey +2348000000000!"
  );
});

test("renderTemplate prefers the contact name over fallbackName", () => {
  assert.equal(
    renderTemplate("{{name}} / {{full_name}}", {
      name: "Ada Lovelace",
      fallbackName: "Friend",
      phone: "+2348000000000",
    }),
    "Ada / Ada Lovelace"
  );
});

test("renderTemplate leaves unknown placeholders untouched", () => {
  assert.equal(
    renderTemplate("{{name}}, order {{order_id}} is ready", { name: "Ada Lovelace" }),
    "Ada, order {{order_id}} is ready"
  );
});

test("renderTemplate returns non-string / empty input unchanged", () => {
  assert.equal(renderTemplate("", { name: "Ada" }), "");
  assert.equal(renderTemplate(undefined, { name: "Ada" }), undefined);
  assert.equal(renderTemplate(null, { name: "Ada" }), null);
});
