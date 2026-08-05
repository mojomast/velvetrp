import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { CHARACTER_BUILDER_STANDARD_ARRAY } from "@velvet/contracts";
import { createRepository } from "../src/repo/index.js";
import { useTmpDataDir } from "./helpers.js";

useTmpDataDir();
const dataDir=()=>process.env.VELVET_DATA_DIR as string;
const dbPath=()=>path.join(dataDir(),"velvet.sqlite");
const canonical=(value:unknown):string=>JSON.stringify(value&&typeof value==="object"&&!Array.isArray(value)
  ?Object.fromEntries(Object.entries(value as Record<string,unknown>).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>[key,JSON.parse(canonical(child))]))
  :Array.isArray(value)?value.map((child)=>JSON.parse(canonical(child))):value);

function seeded(){
  const repo=createRepository({dataDir:dataDir(),clock:{now:()=>new Date("2031-01-01T00:00:00.000Z")}});
  const persona=repo.createCharacter({name:"Provenance",age:30,archetype:"Warden",boundaries:"",safeWord:"pause",fictionalConfirmed:true});
  const campaign=repo.createCampaign("local-owner",{name:"Provenance"});repo.installMechanicsStarterCatalog("local-owner");
  repo.configureMechanicsStarterCatalog("local-owner",campaign.id,{expectedRevision:0,idempotencyKey:"prov-pins"});
  const values=Object.fromEntries(["might","agility","resolve","insight","presence","craft"].map((key,index)=>[key,CHARACTER_BUILDER_STANDARD_ARRAY[index]])) as any;
  const created=repo.createCharacterDraft("local-owner",campaign.id,{personaId:persona.id,controllerPrincipalId:"local-owner",durability:"durable",
    allocation:{method:"standard-array",scores:values},idempotencyKey:"prov-create"});
  return{repo,campaign,created};
}

describe("character draft v20 command provenance",()=>{
  it("stores byte-exact proposed event/result and path-binds authoritative receipt reads",()=>{
    const {repo,campaign,created}=seeded();
    expect(repo.getCharacterDraftReceipt("local-owner",created.draft.id,created.receipt.commandId)).toEqual(created.receipt);
    expect(repo.getCharacterDraftReceipt("local-owner",created.draft.id,"missing-command")).toBeNull();
    const db=new DatabaseDriver(dbPath(),{readonly:true});
    const row=db.prepare(`SELECT proposal.proposed_event_id,proposal.proposed_event_json,proposal.proposed_result_json,
        event.event_id,event.public_data,receipt.result_json,command.command_id,command.campaign_id
      FROM character_draft_command_provenance_v20 proposal
      JOIN character_draft_commands_v19 command ON command.draft_id=proposal.draft_id AND command.command_id=proposal.command_id
      JOIN character_draft_events_v19 event ON event.draft_id=proposal.draft_id AND event.command_id=proposal.command_id
      JOIN character_draft_receipts_v19 receipt ON receipt.draft_id=proposal.draft_id AND receipt.command_id=proposal.command_id
      WHERE proposal.draft_id=?`).get(created.draft.id) as any;
    expect(row.proposed_event_id).toBe(row.event_id);expect(row.proposed_result_json).toBe(row.result_json);
    const event=JSON.parse(row.proposed_event_json);expect(event).toMatchObject({campaignId:campaign.id,commandId:row.command_id,
      draftId:created.draft.id,eventId:row.event_id,publicData:JSON.parse(row.public_data)});db.close();repo.close();
  });

  it("treats request_digest as informational while retry identity uses canonical requested_json",()=>{
    const {repo,campaign,created}=seeded();const db=new DatabaseDriver(dbPath());
    db.exec("DROP TRIGGER character_draft_commands_v19_immutable_update");
    db.prepare("UPDATE character_draft_commands_v19 SET request_digest=? WHERE draft_id=?").run("f".repeat(64),created.draft.id);
    db.exec("CREATE TRIGGER character_draft_commands_v19_immutable_update BEFORE UPDATE ON character_draft_commands_v19 BEGIN SELECT RAISE(ABORT,'character draft commands are immutable'); END;");db.close();
    const retry=repo.createCharacterDraft("local-owner",campaign.id,{personaId:created.draft.personaId,
      controllerPrincipalId:"local-owner",durability:"durable",allocation:{method:"standard-array",scores:created.draft.allocation.scores},
      idempotencyKey:"prov-create"});expect(retry).toEqual(created);
    expect(()=>repo.createCharacterDraft("local-owner",campaign.id,{personaId:created.draft.personaId,
      controllerPrincipalId:"local-owner",durability:"expiring",allocation:{method:"standard-array",scores:created.draft.allocation.scores},
      idempotencyKey:"prov-create"})).toThrow("idempotency key");repo.close();
  });

  it("rejects forged proposal, event, and receipt substitutions transactionally",()=>{
    const {repo,campaign,created}=seeded();repo.close();const db=new DatabaseDriver(dbPath());db.pragma("foreign_keys = ON");
    const stored=db.prepare("SELECT result_json FROM character_draft_receipts_v19 WHERE draft_id=?").get(created.draft.id) as {result_json:string};
    const result=JSON.parse(stored.result_json);result.receipt.commandId="forged-command";result.receipt.idempotencyKey="forged-key";
    const publicData={draftId:created.draft.id,revision:0,status:"active"};
    const event={actorPrincipalId:"local-owner",campaignId:campaign.id,commandId:"forged-command",draftId:created.draft.id,
      eventId:"forged-event",occurredAt:"2031-01-01T00:00:00.000Z",publicData,revision:0,revisionBefore:0,type:"draft_created"};
    const insertCommand=()=>db.prepare(`INSERT INTO character_draft_commands_v19
      (draft_id,command_id,campaign_id,actor_principal_id,idempotency_key,type,expected_revision,requested_json,request_digest,created_at)
      VALUES (?,?,?,'local-owner','forged-key','create',0,'{"idempotencyKey":"forged-key"}',?,'2031-01-01T00:00:00.000Z')`)
      .run(created.draft.id,"forged-command",campaign.id,"0".repeat(64));
    expect(()=>db.transaction(()=>{insertCommand();db.prepare(`INSERT INTO character_draft_command_provenance_v20 VALUES (?,?,?,?,?,?,?,?)`)
      .run(created.draft.id,"forged-command",campaign.id,"local-owner","forged-event","draft_created",
        canonical({...event,campaignId:"other-campaign"}),canonical(result));})()).toThrow(/proposal is inconsistent|UNIQUE constraint/);
    expect(()=>db.transaction(()=>{insertCommand();db.prepare(`INSERT INTO character_draft_command_provenance_v20 VALUES (?,?,?,?,?,?,?,?)`)
      .run(created.draft.id,"forged-command",campaign.id,"local-owner","forged-event","draft_created",canonical(event),canonical(result));
      db.prepare(`INSERT INTO character_draft_events_v19 VALUES (?,?,?,?,?,?,?,?)`).run(created.draft.id,"forged-command","substituted-event",
        "draft_created",0,0,"2031-01-01T00:00:00.000Z",canonical(publicData));})()).toThrow(/exact proposal|UNIQUE constraint/);
    expect(()=>db.transaction(()=>{insertCommand();db.prepare(`INSERT INTO character_draft_command_provenance_v20 VALUES (?,?,?,?,?,?,?,?)`)
      .run(created.draft.id,"forged-command",campaign.id,"local-owner","forged-event","draft_created",canonical(event),canonical(result));
      db.prepare(`INSERT INTO character_draft_events_v19 VALUES (?,?,?,?,?,?,?,?)`).run(created.draft.id,"forged-command","forged-event",
        "draft_created",0,0,"2031-01-01T00:00:00.000Z",canonical(publicData));
      db.prepare(`INSERT INTO character_draft_receipts_v19 VALUES (?,?,?,?,?,?)`).run(created.draft.id,"forged-command","forged-event",0,0,"{}");})())
      .toThrow(/exact proposal|UNIQUE constraint/);
    expect(db.prepare("SELECT COUNT(*) count FROM character_draft_commands_v19 WHERE command_id='forged-command'").get()).toEqual({count:0});db.close();
  });

  it("rejects a coherent parallel command/event/receipt proposal for existing draft revision zero",()=>{
    const {repo,campaign,created}=seeded();repo.close();const db=new DatabaseDriver(dbPath());db.pragma("foreign_keys = ON");
    const stored=db.prepare("SELECT result_json FROM character_draft_receipts_v19 WHERE draft_id=?").get(created.draft.id) as {result_json:string};
    const result=JSON.parse(stored.result_json);result.receipt.commandId="parallel-command";result.receipt.idempotencyKey="parallel-key";
    const publicData={draftId:created.draft.id,revision:0,status:"active"};
    const event={actorPrincipalId:"local-owner",campaignId:campaign.id,commandId:"parallel-command",draftId:created.draft.id,
      eventId:"parallel-event",occurredAt:"2031-01-01T00:00:00.000Z",publicData,revision:0,revisionBefore:0,type:"draft_created"};
    expect(()=>db.transaction(()=>{
      db.prepare(`INSERT INTO character_draft_commands_v19
        (draft_id,command_id,campaign_id,actor_principal_id,idempotency_key,type,expected_revision,requested_json,request_digest,created_at)
        VALUES (?,?,?,'local-owner','parallel-key','create',0,'{"idempotencyKey":"parallel-key"}',?,'2031-01-01T00:00:00.000Z')`)
        .run(created.draft.id,"parallel-command",campaign.id,"0".repeat(64));
      db.prepare("INSERT INTO character_draft_command_provenance_v20 VALUES (?,?,?,?,?,?,?,?)").run(created.draft.id,"parallel-command",
        campaign.id,"local-owner","parallel-event","draft_created",canonical(event),canonical(result));
    })()).toThrow(/UNIQUE constraint failed/);
    expect(db.prepare("SELECT COUNT(*) count FROM character_draft_commands_v19 WHERE draft_id=?").get(created.draft.id)).toEqual({count:1});
    expect(db.prepare("SELECT COUNT(*) count FROM character_draft_receipts_v19 WHERE draft_id=? AND revision_after=0").get(created.draft.id)).toEqual({count:1});db.close();
  });
});
