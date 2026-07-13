import test from "node:test";
import assert from "node:assert/strict";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { Host, SSHKey } from "../types.ts";
import {
  applyEffectiveHostAuthMethodSelection,
  HostDetailsConnectionSections,
} from "./HostDetailsConnectionSections.tsx";
import { TooltipProvider } from "./ui/tooltip.tsx";

const longCredentialLabel =
  "D:\\download\\acdrOgxses_wuzh02.hpccube.com_really_really_long_private_key_name.pem";

const availableKey: SSHKey = {
  id: "key-1",
  label: longCredentialLabel,
  type: "ED25519",
  privateKey: "",
  publicKey: "",
  source: "imported",
  category: "key",
  created: 1,
};

const renderConnectionSections = (formOverrides: Record<string, unknown> = {}) =>
  renderToStaticMarkup(
    React.createElement(
      TooltipProvider,
      null,
      React.createElement(HostDetailsConnectionSections, {
        t: (key: string) => key,
        form: {
          id: "host-1",
          label: "Host",
          hostname: "example.com",
          username: "root",
          port: 22,
          protocol: "ssh",
          os: "linux",
          authMethod: "key",
          identityFileId: availableKey.id,
          ...formOverrides,
        },
        setForm: () => {},
        update: () => {},
        groupDefaults: undefined,
        effectiveAuthMethod: formOverrides.effectiveAuthMethod || formOverrides.authMethod || "key",
        effectiveIdentityId: formOverrides.effectiveIdentityId || formOverrides.identityId,
        selectedIdentity: undefined,
        clearIdentity: () => {},
        identities: [],
        identitySuggestionsOpen: false,
        filteredIdentitySuggestions: [],
        setIdentitySuggestionsOpen: () => {},
        availableKeys: [availableKey],
        applyIdentity: () => {},
        showPassword: false,
        setShowPassword: () => {},
        pendingReferenceKeyPath: null,
        setPendingReferenceKeyPath: () => {},
        selectedCredentialType: null,
        setSelectedCredentialType: () => {},
        credentialPopoverOpen: false,
        setCredentialPopoverOpen: () => {},
        keysByCategory: { key: [availableKey], certificate: [] },
        newKeyFilePath: "",
        setNewKeyFilePath: () => {},
        addLocalKeyFilePath: () => {},
        handleDistroModeChange: () => {},
        distroOptions: [],
        effectiveFormDistro: undefined,
        getDistroOptionLabel: () => "",
      }),
    ),
  );

test("selected host credential keeps the remove button visible with a long name", () => {
  const markup = renderConnectionSections();

  assert.match(markup, new RegExp(longCredentialLabel.replaceAll("\\", "\\\\")));
  assert.match(
    markup,
    /class="flex items-center gap-2 min-w-0 overflow-hidden p-2 rounded-md bg-secondary\/50 border border-border\/60"/,
  );
  assert.match(markup, /class="text-sm min-w-0 flex-1 truncate"/);
  assert.match(markup, /class="[^"]*h-6 w-6 shrink-0[^"]*"/);
});

test("color and icon settings render for non-Linux hosts", () => {
  const markup = renderConnectionSections({
    os: "macos",
    distro: "macos",
    iconMode: "custom",
    iconId: "terminal",
  });

  assert.match(markup, /hostDetails\.icon\.sectionTitle/);
  assert.match(markup, /hostDetails\.icon\.colorLabel/);
  assert.match(markup, /hostDetails\.icon\.manualLabel/);
});

test("host credentials expose automatic and password-only choices", () => {
  const markup = renderConnectionSections({
    authMethod: "auto",
    identityFileId: undefined,
  });

  assert.match(markup, /hostDetails\.auth\.method/);
  assert.match(markup, /hostDetails\.auth\.auto/);
  assert.match(markup, /hostDetails\.auth\.passwordOnly/);
  assert.match(markup, /hostDetails\.auth\.key/);
  assert.match(markup, /hostDetails\.auth\.certificate/);
});

test("host authentication choices remain visible for a selected identity", () => {
  const markup = renderConnectionSections({
    identityId: "identity-1",
    authMethod: "password",
  });

  assert.match(markup, /hostDetails\.auth\.passwordOnly/);
});

test("host authentication choices show the inherited effective method", () => {
  const markup = renderConnectionSections({
    authMethod: undefined,
    identityFileId: undefined,
    effectiveAuthMethod: "password",
  });

  assert.match(markup, /<button[^>]*aria-pressed="true"[^>]*>hostDetails\.auth\.passwordOnly<\/button>/);
});

test("reselecting an inherited authentication method preserves group credentials", () => {
  const host = {
    id: "host-1",
    label: "Host",
    hostname: "example.com",
    username: "root",
  } as Host;

  assert.equal(applyEffectiveHostAuthMethodSelection(host, "key", "key"), host);
});

test("an inherited deleted identity remains visible and clearable", () => {
  const markup = renderConnectionSections({
    authMethod: undefined,
    identityFileId: undefined,
    effectiveAuthMethod: "auto",
    effectiveIdentityId: "deleted-group-identity",
  });

  assert.match(markup, /hostDetails\.identity\.missing/);
  assert.doesNotMatch(markup, /placeholder="hostDetails\.username\.placeholder"/);
});
