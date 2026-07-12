import assert from "node:assert/strict";
import test from "node:test";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { I18nProvider } from "../application/i18n/I18nProvider";
import QuickConnectWizard from "./QuickConnectWizard";

test("quick connect shows saved identities as credential presets", () => {
  const markup = renderToStaticMarkup(
    <I18nProvider locale="en">
      <QuickConnectWizard
        open
        target={{ hostname: "192.0.2.10" }}
        keys={[]}
        identities={[{
          id: "identity-root",
          label: "Root devices",
          username: "root",
          authMethod: "password",
          password: "secret",
          created: 1,
        }]}
        onConnect={() => undefined}
        onClose={() => undefined}
      />
    </I18nProvider>,
  );

  assert.match(markup, /Credential preset/);
  assert.match(markup, /Choose a saved identity/);
});
