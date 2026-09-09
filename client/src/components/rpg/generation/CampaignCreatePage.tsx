import { useEffect, useState } from "react";
import { getCampaignAdministration, getProvider, preflightProviderCapabilities, type ProviderSettings, type ProviderCapabilityPreflightResult } from "../../../api";
import { CampaignGeneratorPanel } from "../campaign/CampaignGeneratorPanel";
import "./campaign-create.css";

export function CampaignCreatePage({ campaignId, onBack }: { campaignId: string; onBack: () => void }) {
  return <CampaignCreateWorkspace key={campaignId} campaignId={campaignId} onBack={onBack} />;
}

function CampaignCreateWorkspace({ campaignId, onBack }: { campaignId: string; onBack: () => void }) {
  const [access, setAccess] = useState<"loading" | "allowed" | "denied" | "error">("loading");
  const [provider, setProvider] = useState<ProviderSettings | null>(null);
  const [setupError, setSetupError] = useState("");
  const [checking, setChecking] = useState(false);
  const [capabilities, setCapabilities] = useState<ProviderCapabilityPreflightResult | null>(null);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    let current = true;
    void getCampaignAdministration(campaignId).then(async ({ campaign }) => {
      if (!current) return;
      if (campaign.actorRole !== "owner" && campaign.actorRole !== "gm") { setAccess("denied"); return; }
      setAccess("allowed");
      try {
        const settings = await getProvider();
        if (current) { setProvider(settings); setSetupError(""); setCapabilities(null); }
      } catch { if (current) { setProvider(null); setSetupError("Provider settings could not be read. Ask the server operator to verify configuration, then refresh setup."); } }
    }).catch(() => { if (current) setAccess("error"); });
    return () => { current = false; };
  }, [campaignId, refresh]);

  async function checkProvider() {
    setChecking(true); setSetupError("");
    try { setCapabilities(await preflightProviderCapabilities()); }
    catch { setSetupError("The capability check could not confirm readiness. No campaign candidate was generated. Verify the endpoint and try again."); }
    finally { setChecking(false); }
  }

  const configured = Boolean(provider?.baseUrl.trim() && provider?.model.trim());
  return <main className="campaign-create-page" data-testid="campaign-create-page">
    <header><p className="eyebrow">DM PREPARATION / CAMPAIGN WORKSPACE</p><h1>Create your campaign</h1><p>Turn an idea into connected material. You decide what becomes canon.</p></header>
    {access !== "allowed" && <button type="button" onClick={onBack}>Back to campaign</button>}
    {access === "loading" && <p role="status">Checking campaign permissions...</p>}
    {access === "denied" && <section aria-label="Generation permission"><h2>DM access required</h2><p>Only the campaign owner or GM can generate and apply campaign material. Ask them to prepare this campaign.</p></section>}
    {access === "error" && <section role="alert"><p>Campaign permissions could not be verified. Generation remains unavailable.</p><button type="button" onClick={() => setRefresh((value) => value + 1)}>Retry permissions</button></section>}
    {access === "allowed" && <>
      <details className="campaign-create-setup" open={!configured || capabilities?.campaignGenerationCompatible === false}>
        <summary>Provider setup: {configured ? `${provider?.model} / ${capabilities?.campaignGenerationCompatible ? "capability check passed" : "not verified"}` : "configuration needed"}</summary>
        <p>Configure the endpoint, model, and any required credentials in application provider settings. Local endpoints may not require an API key. Configuration alone does not prove the provider supports campaign generation.</p>
        {provider && <p>{provider.providerType} / {provider.model || "No model selected"} / credentials {provider.hasApiKey ? "configured" : "not configured"}</p>}
        <p>Capability checks contact the provider and may incur cost. Opening this workspace only reads settings; it never generates or probes automatically.</p>
        {capabilities && <p role="status">{capabilities.campaignGenerationCompatible ? "Campaign generation capability confirmed. Candidate quality and playable readiness still require review." : "Campaign generation capability was not confirmed. Select a model supporting strict JSON schema, then refresh setup and check again."}</p>}
        {setupError && <p role="alert">{setupError}</p>}
        <div className="campaign-create-actions"><button type="button" disabled={checking} onClick={() => setRefresh((value) => value + 1)}>Refresh setup</button><button type="button" disabled={!configured || checking} onClick={() => void checkProvider()}>{checking ? "Checking provider..." : "Check provider capability (may incur cost)"}</button></div>
      </details>
      <CampaignGeneratorPanel campaignId={campaignId} disabled={!configured || checking || capabilities?.campaignGenerationCompatible === false} onBack={onBack} />
    </>}
  </main>;
}
