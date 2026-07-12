import {
  ArrowLeft,
  ChevronDown,
  Eye,
  EyeOff,
  Globe,
  Key,
  Lock,
  Plus,
  Terminal as TerminalIcon,
  User,
} from "lucide-react";
import React, { useMemo, useState } from "react";
import { useI18n } from "../application/i18n/I18nProvider";
import type { QuickConnectTarget } from "../domain/quickConnect";
import { formatHostPort } from "../domain/host";
import {
  buildQuickConnectHost,
  isQuickConnectIdentityUsable,
  type QuickConnectAuthMethod,
  type QuickConnectProtocol,
} from "../domain/quickConnectHost";
import { cn } from "../lib/utils";
import { Host, Identity, SSHKey } from "../types";
import { Button } from "./ui/button";
import { Combobox } from "./ui/combobox";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { ScrollArea } from "./ui/scroll-area";

// Protocol types supported for quick connect
type Protocol = QuickConnectProtocol;

// Wizard steps
type WizardStep = "protocol" | "username" | "knownhost" | "auth";

interface QuickConnectWizardProps {
  open: boolean;
  target: QuickConnectTarget;
  keys: SSHKey[];
  identities: Identity[];
  warnings?: string[];
  onConnect: (host: Host) => void;
  onSaveHost?: (host: Host) => void;
  onAddKey?: () => void;
  onClose: () => void;
}

const QuickConnectWizard: React.FC<QuickConnectWizardProps> = ({
  open,
  target,
  keys,
  identities,
  warnings,
  onConnect,
  onSaveHost,
  onAddKey,
  onClose,
}) => {
  const { t } = useI18n();
  // Wizard state
  const [step, setStep] = useState<WizardStep>("protocol");
  const [protocol, setProtocol] = useState<Protocol>("ssh");
  const [username, setUsername] = useState(target.username || "");
  const [port, setPort] = useState<number>(target.port || 22);
  const [moshServerPath, setMoshServerPath] = useState("");
  const [showLogs, setShowLogs] = useState(false);

  // Known host verification state
  const [knownHostInfo, setKnownHostInfo] = useState<{
    keyType: string;
    fingerprint: string;
  } | null>(null);

  // Auth state
  const [authMethod, setAuthMethod] = useState<QuickConnectAuthMethod>("password");
  const [password, setPassword] = useState("");
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const [selectedIdentityId, setSelectedIdentityId] = useState<string | null>(null);
  const [showPassword, setShowPassword] = useState(false);
  const [saveCredentials] = useState(true);

  // Reset state when target changes
  React.useEffect(() => {
    if (open) {
      setStep("protocol");
      setProtocol("ssh");
      setUsername(target.username || "");
      setPort(target.port || 22);
      setPassword("");
      setSelectedKeyId(null);
      setSelectedIdentityId(null);
      setShowPassword(false);
      setKnownHostInfo(null);
    }
  }, [open, target]);

  const selectedIdentity = useMemo(
    () => identities.find((identity) => identity.id === selectedIdentityId),
    [identities, selectedIdentityId],
  );
  const canUseSelectedIdentity = useMemo(
    () => isQuickConnectIdentityUsable(selectedIdentity, keys, protocol),
    [keys, protocol, selectedIdentity],
  );
  const identityOptions = useMemo(
    () => identities.map((identity) => ({
      value: identity.id,
      label: identity.label,
      sublabel: identity.username,
      icon: <User size={14} />,
    })),
    [identities],
  );

  const detachSelectedIdentity = () => {
    setSelectedIdentityId(null);
    setAuthMethod("password");
    setPassword("");
    setSelectedKeyId(null);
  };

  const clearSelectedIdentity = () => {
    detachSelectedIdentity();
    setUsername(target.username || "");
  };

  const handleIdentitySelect = (identityId: string) => {
    if (!identityId) {
      clearSelectedIdentity();
      return;
    }
    const identity = identities.find((candidate) => candidate.id === identityId);
    if (!identity) return;
    setSelectedIdentityId(identity.id);
    setUsername(identity.username);
    setAuthMethod(identity.authMethod);
    setPassword("");
    setSelectedKeyId(identity.keyId || null);
  };

  // Get default port for protocol
  const getDefaultPort = (proto: Protocol) => {
    switch (proto) {
      case "ssh":
        return 22;
      case "mosh":
        return 22;
      case "telnet":
        return 23;
      default:
        return 22;
    }
  };

  // Handle protocol selection
  const handleProtocolSelect = (proto: Protocol) => {
    if (proto === "telnet" && selectedIdentityId) {
      clearSelectedIdentity();
    }
    setProtocol(proto);
    // Update port to default for protocol if unchanged
    if (port === getDefaultPort(protocol)) {
      setPort(getDefaultPort(proto));
    }
  };

  // Navigate to next step
  const handleContinue = () => {
    switch (step) {
      case "protocol":
        if (canUseSelectedIdentity) {
          handleConnect();
          break;
        }
        // Always go to username step to let user confirm/edit username
        setStep("username");
        break;
      case "username":
        setStep("auth");
        break;
      case "knownhost":
        setStep("auth");
        break;
      case "auth":
        handleConnect();
        break;
    }
  };

  // Navigate back
  const handleBack = () => {
    switch (step) {
      case "username":
        setStep("protocol");
        break;
      case "knownhost":
        setStep("username");
        break;
      case "auth":
        // Always go back to username step
        setStep("username");
        break;
    }
  };

  // Create host and connect
  const handleConnect = () => {
    const effectiveUsername = username || target.username || "root";
    const effectivePort = port || getDefaultPort(protocol);
    const activeIdentityId = selectedIdentity?.id || null;

    const now = Date.now();
    const tempHost = buildQuickConnectHost({
      id: `quick-${now}-${Math.random().toString(36).slice(2, 11)}`,
      createdAt: now,
      target,
      protocol,
      port: effectivePort,
      username: effectiveUsername,
      authMethod,
      password,
      selectedKeyId,
      selectedIdentityId: activeIdentityId,
    });

    // Save host if requested
    if (saveCredentials && onSaveHost && !activeIdentityId) {
      onSaveHost(tempHost);
    }

    onConnect(tempHost);
    onClose();
  };

  // Check if can proceed
  const canProceed = useMemo(() => {
    switch (step) {
      case "protocol":
        return true;
      case "username":
        return username.trim().length > 0;
      case "knownhost":
        return true;
      case "auth":
        if (selectedIdentity) return canUseSelectedIdentity;
        if (authMethod === "password") {
          // Whitespace-only passwords are valid SSH secrets (issue #2036).
          return password.length > 0;
        }
        return Boolean(selectedKeyId && keys.some((key) => key.id === selectedKeyId));
    }
  }, [step, username, authMethod, password, selectedKeyId, selectedIdentity, canUseSelectedIdentity, keys]);

  // Render protocol selection step
  const renderProtocolStep = () => (
    <div className="space-y-4">
      <h3 className="text-base font-semibold">{t("protocolSelect.chooseProtocol")}</h3>
      <div className="space-y-3">
        {/* SSH */}
        <button
          className={cn(
            "w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all text-left",
            protocol === "ssh"
              ? "border-primary bg-primary/5"
              : "border-border/60 hover:border-border hover:bg-secondary/50",
          )}
          onClick={() => handleProtocolSelect("ssh")}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "h-10 w-10 rounded-lg flex items-center justify-center",
                protocol === "ssh"
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <TerminalIcon size={18} />
            </div>
            <div>
              <div className="font-medium">SSH</div>
              <div className="text-xs text-muted-foreground font-mono">
                ssh {target.hostname}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("protocolSelect.port")}</span>
            <Input
              type="number"
              value={protocol === "ssh" ? port : 22}
              onChange={(e) => {
                setPort(parseInt(e.target.value) || 22);
                setProtocol("ssh");
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-16 h-7 text-xs text-center"
              min={1}
              max={65535}
            />
          </div>
        </button>

        {/* Mosh */}
        <button
          className={cn(
            "w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all text-left",
            protocol === "mosh"
              ? "border-primary bg-primary/5"
              : "border-border/60 hover:border-border hover:bg-secondary/50",
          )}
          onClick={() => handleProtocolSelect("mosh")}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "h-10 w-10 rounded-lg flex items-center justify-center",
                protocol === "mosh"
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <Globe size={18} />
            </div>
            <div>
              <div className="font-medium">Mosh</div>
              <div className="text-xs text-muted-foreground font-mono">
                mosh {target.hostname}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("protocolSelect.port")}</span>
            <Input
              type="number"
              value={protocol === "mosh" ? port : 22}
              onChange={(e) => {
                setPort(parseInt(e.target.value) || 22);
                setProtocol("mosh");
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-16 h-7 text-xs text-center"
              min={1}
              max={65535}
            />
            <Input
              type="text"
              value={moshServerPath}
              onChange={(e) => setMoshServerPath(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              placeholder="mosh --server=/path/server host"
              className="w-40 h-7 text-xs"
            />
          </div>
        </button>

        {/* Telnet */}
        <button
          className={cn(
            "w-full flex items-center justify-between px-4 py-3 rounded-xl border-2 transition-all text-left",
            protocol === "telnet"
              ? "border-primary bg-primary/5"
              : "border-border/60 hover:border-border hover:bg-secondary/50",
          )}
          onClick={() => handleProtocolSelect("telnet")}
        >
          <div className="flex items-center gap-3">
            <div
              className={cn(
                "h-10 w-10 rounded-lg flex items-center justify-center",
                protocol === "telnet"
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <TerminalIcon size={18} />
            </div>
            <div>
              <div className="font-medium">Telnet</div>
              <div className="text-xs text-muted-foreground font-mono">
                telnet {target.hostname}
              </div>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <span className="text-xs text-muted-foreground">{t("protocolSelect.port")}</span>
            <Input
              type="number"
              value={protocol === "telnet" ? port : 23}
              onChange={(e) => {
                handleProtocolSelect("telnet");
                setPort(parseInt(e.target.value) || 23);
              }}
              onClick={(e) => e.stopPropagation()}
              className="w-16 h-7 text-xs text-center"
              min={1}
              max={65535}
            />
          </div>
        </button>
      </div>

      {protocol !== "telnet" && identities.length > 0 && (
        <div className="space-y-2 pt-1">
          <Label>{t("quickConnect.identity.label")}</Label>
          <Combobox
            options={identityOptions}
            value={selectedIdentityId || undefined}
            onValueChange={handleIdentitySelect}
            placeholder={t("quickConnect.identity.placeholder")}
            emptyText={t("quickConnect.identity.empty")}
            icon={<User size={14} />}
          />
          <p className="text-xs text-muted-foreground">
            {selectedIdentity
              ? t("quickConnect.identity.selectedHint", { username: selectedIdentity.username })
              : t("quickConnect.identity.hint")}
          </p>
        </div>
      )}
    </div>
  );

  // Render username step
  const renderUsernameStep = () => (
    <div className="space-y-4">
      <div className="space-y-2">
        <Label htmlFor="quick-username">{t("terminal.auth.username")}</Label>
        <Input
          id="quick-username"
          value={username}
          onChange={(e) => {
            if (selectedIdentityId) detachSelectedIdentity();
            setUsername(e.target.value);
          }}
          placeholder={t("terminal.auth.username.placeholder")}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && username.trim()) {
              handleContinue();
            }
          }}
        />
      </div>
    </div>
  );

  // Render known host verification step
  const renderKnownHostStep = () => (
    <div className="space-y-4">
      <h3 className="text-base font-semibold text-amber-600 dark:text-amber-500">
        {t("quickConnect.knownHost.title")}
      </h3>
      <div className="space-y-2 text-sm text-muted-foreground">
        <p>{t("quickConnect.knownHost.authenticity", { hostname: target.hostname })}</p>
        {knownHostInfo && (
          <>
            <p className="font-medium text-foreground">
              {t("quickConnect.knownHost.fingerprintLabel", { keyType: knownHostInfo.keyType })}
            </p>
            <p className="font-mono text-xs bg-muted p-2 rounded break-all">
              {knownHostInfo.fingerprint}
            </p>
          </>
        )}
        <p>{t("quickConnect.knownHost.addQuestion")}</p>
      </div>
    </div>
  );

  // Render auth step
  const renderAuthStep = () => (
    <div className="space-y-4">
      {selectedIdentity ? (
        <div className="rounded-xl border border-primary/40 bg-primary/5 p-4 space-y-3">
          <div className="flex items-center gap-3">
            <div className="h-9 w-9 rounded-lg bg-primary/15 text-primary flex items-center justify-center">
              <User size={16} />
            </div>
            <div className="min-w-0 flex-1">
              <div className="font-medium truncate">{selectedIdentity.label}</div>
              <div className="text-xs text-muted-foreground truncate">
                {selectedIdentity.username} · {t(`quickConnect.identity.method.${selectedIdentity.authMethod}`)}
              </div>
            </div>
          </div>
          {!canUseSelectedIdentity && (
            <p className="text-xs text-destructive">
              {t("quickConnect.identity.unavailable")}
            </p>
          )}
          <Button variant="outline" size="sm" className="w-full" onClick={detachSelectedIdentity}>
            {t("quickConnect.identity.useCustom")}
          </Button>
        </div>
      ) : (
        <>
      {/* Auth method tabs */}
      <div className="flex gap-1 p-1 bg-secondary/80 rounded-lg border border-border/60">
        <button
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all",
            authMethod === "password"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground hover:bg-secondary",
          )}
          onClick={() => {
            setSelectedIdentityId(null);
            setAuthMethod("password");
          }}
        >
          <Lock size={14} />
          {t("terminal.auth.password")}
        </button>
        <button
          className={cn(
            "flex-1 flex items-center justify-center gap-2 py-2 text-sm font-medium rounded-md transition-all",
            authMethod !== "password"
              ? "bg-primary text-primary-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground hover:bg-secondary",
          )}
          onClick={() => {
            setSelectedIdentityId(null);
            setAuthMethod("key");
          }}
        >
          <Key size={14} />
          {t("terminal.auth.sshKey")}
        </button>
      </div>

      {/* Password field */}
      {authMethod === "password" && (
        <div className="space-y-2">
          <Label htmlFor="quick-password">{t("terminal.auth.passwordLabel")}</Label>
          <div className="relative">
            <Input
              id="quick-password"
              type={showPassword ? "text" : "password"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              placeholder={t("terminal.auth.password.placeholder")}
              className="pr-10"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter" && password.length > 0) {
                  handleConnect();
                }
              }}
            />
            <button
              type="button"
              className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              onClick={() => setShowPassword(!showPassword)}
            >
              {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
            </button>
          </div>
        </div>
      )}

      {/* Key selection */}
      {authMethod === "key" && (
        <div className="space-y-2">
          {keys.filter((k) => k.category === "key").length === 0 ? (
            <div className="text-sm text-muted-foreground p-3 border border-dashed border-border/60 rounded-lg text-center">
              {t("terminal.auth.noKeysHint")}
            </div>
          ) : (
            <ScrollArea className="max-h-48">
              <div className="space-y-2">
                {keys
                  .filter((k) => k.category === "key")
                  .map((key) => (
                    <button
                      key={key.id}
                      className={cn(
                        "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border transition-colors text-left",
                        selectedKeyId === key.id
                          ? "border-primary bg-primary/5"
                          : "border-border/50 hover:bg-secondary/50",
                      )}
                      onClick={() => {
                        setSelectedIdentityId(null);
                        setSelectedKeyId(key.id);
                      }}
                    >
                      <div
                        className={cn(
                          "h-8 w-8 rounded-lg flex items-center justify-center",
                          "bg-primary/20 text-primary",
                        )}
                      >
                        <Key size={14} />
                      </div>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium truncate">
                          {key.label}
                        </div>
                        <div className="text-xs text-muted-foreground">
                          Type {key.type}
                        </div>
                      </div>
                    </button>
                  ))}
              </div>
            </ScrollArea>
          )}

          {onAddKey && (
            <Button
              variant="outline"
              size="sm"
              className="w-full mt-2"
              onClick={onAddKey}
            >
              <Plus size={14} className="mr-2" />
              Add key
            </Button>
          )}
        </div>
      )}
        </>
      )}
    </div>
  );

  // Get step title
  const getStepTitle = () => {
    switch (step) {
      case "protocol":
        return target.hostname;
      case "username":
        return target.hostname;
      case "knownhost":
        return target.hostname;
      case "auth":
        return target.hostname;
    }
  };

  // Get step subtitle
  const getStepSubtitle = () => {
    const effectiveUsername = username || target.username || "";
    switch (step) {
      case "protocol":
        return target.hostname;
      case "username":
        return `${protocol.toUpperCase()} ${formatHostPort(target.hostname, port)}`;
      case "knownhost":
        return `${protocol.toUpperCase()} ${effectiveUsername}@${formatHostPort(target.hostname, port)}`;
      case "auth":
        return `${protocol.toUpperCase()} ${formatHostPort(target.hostname, port)}`;
    }
  };

  // Render progress indicator
  const renderProgressIndicator = () => {
    const steps: WizardStep[] = target.username
      ? ["protocol", "auth"]
      : ["protocol", "username", "auth"];
    const currentIndex = steps.indexOf(step);

    return (
      <div className="flex items-center gap-3 py-3">
        <div
          className={cn(
            "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0",
            currentIndex >= 0
              ? "bg-primary/20 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          <TerminalIcon size={14} />
        </div>
        <div className="flex-1 h-0.5 bg-muted" />
        {!target.username && (
          <>
            <div
              className={cn(
                "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0",
                currentIndex >= 1
                  ? "bg-primary/20 text-primary"
                  : "bg-muted text-muted-foreground",
              )}
            >
              <User size={14} />
            </div>
            <div className="flex-1 h-0.5 bg-muted" />
          </>
        )}
        <div
          className={cn(
            "h-8 w-8 rounded-full flex items-center justify-center flex-shrink-0",
            step === "auth"
              ? "bg-primary/20 text-primary"
              : "bg-muted text-muted-foreground",
          )}
        >
          {authMethod === "password" ? <Lock size={14} /> : <Key size={14} />}
        </div>
        <div className="flex-1 h-0.5 bg-muted" />
        <div className="h-8 w-8 rounded-full bg-muted text-muted-foreground flex items-center justify-center text-xs font-mono">
          {">_"}
        </div>
      </div>
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      onClick={onClose}
    >
      <div
        className="w-[560px] max-w-[90vw] bg-background border border-border rounded-2xl animate-in fade-in-0 zoom-in-95 duration-200"
        style={{
          boxShadow:
            "0 25px 50px -12px rgba(0, 0, 0, 0.25), 0 12px 24px -8px rgba(0, 0, 0, 0.15)",
        }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="px-6 py-5 border-b border-border/50">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-3">
              <div className="h-12 w-12 rounded-xl bg-primary/15 text-primary flex items-center justify-center">
                <TerminalIcon size={22} />
              </div>
              <div>
                <h2 className="text-base font-semibold">{getStepTitle()}</h2>
                <p className="text-xs text-muted-foreground font-mono">
                  {getStepSubtitle()}
                </p>
              </div>
            </div>
            {(step === "auth" || (step === "knownhost" && !knownHostInfo)) && (
              <Button
                size="sm"
                variant="outline"
                className="h-8 text-xs"
                onClick={() => setShowLogs(!showLogs)}
              >
                {showLogs ? "Hide logs" : "Show logs"}
              </Button>
            )}
          </div>
        </div>

        {/* Progress indicator */}
        <div className="px-6">{renderProgressIndicator()}</div>

        {warnings && warnings.length > 0 && (
          <div className="px-6 pb-2">
            <div className="text-xs text-amber-600 bg-amber-500/10 border border-amber-500/30 rounded-lg px-3 py-2">
              {t("quickConnect.warning.unparsedOptions", {
                options: warnings.join(", "),
              })}
            </div>
          </div>
        )}

        {/* Content */}
        <div className="px-6 py-4">
          {step === "protocol" && renderProtocolStep()}
          {step === "username" && renderUsernameStep()}
          {step === "knownhost" && renderKnownHostStep()}
          {step === "auth" && renderAuthStep()}
        </div>

        {/* Footer */}
        <div className="px-6 py-4 border-t border-border/50 flex items-center justify-between">
          <Button
            variant="secondary"
            onClick={step === "protocol" ? onClose : handleBack}
          >
            {step === "protocol" ? (
              t("common.close")
            ) : (
              <>
                <ArrowLeft size={14} className="mr-2" />
                {t("common.back")}
              </>
            )}
          </Button>

          {step === "knownhost" ? (
            <div className="flex items-center gap-2">
              <Button variant="secondary" onClick={handleContinue}>
                {t("common.continue")}
              </Button>
              <Button
                onClick={() => {
                  // Add to known hosts then continue
                  handleContinue();
                }}
              >
                {t("quickConnect.knownHost.addAndContinue")}
              </Button>
            </div>
          ) : step === "auth" ? (
            <div className="flex items-center gap-2">
              {onAddKey &&
                authMethod === "key" &&
                keys.filter((k) => k.category === "key").length === 0 && (
                  <Button variant="secondary" onClick={onAddKey}>
                    {t("quickConnect.addKey")}
                  </Button>
                )}
              <Button disabled={!canProceed} onClick={handleConnect}>
                {t("terminal.auth.continueSave")}
                <ChevronDown size={14} className="ml-2" />
              </Button>
            </div>
          ) : (
            <Button onClick={handleContinue} disabled={!canProceed}>
              {step === "protocol" && canUseSelectedIdentity
                ? t("quickConnect.identity.connect")
                : t("common.continue")}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
};

export default QuickConnectWizard;
