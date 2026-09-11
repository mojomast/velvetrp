import DatabaseDriver from "better-sqlite3";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createRepository } from "../src/repo/index.js";
import { ensureCurrentSchema } from "../src/repo/db/schema.js";
import { upgradeCampaignDmSchema } from "../src/repo/db/campaignDmUpgrade.js";
import { useTmpDataDir } from "./helpers.js";
import { dmFixture } from './fixtures/dmCampaign.js';

useTmpDataDir();
const objects=(db:DatabaseDriver.Database)=>db.prepare("SELECT type,name,tbl_name,sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as {type:string;name:string;tbl_name:string;sql:string}[];
function predecessor(db:DatabaseDriver.Database,oldMap=false){
  db.pragma("foreign_keys=OFF");const expected=objects(db);
  for(const object of expected.filter(o=>o.name.startsWith("dm_")&&o.type!=="table"))db.exec(`DROP ${object.type} ${object.name}`);
  for(const object of expected.filter(o=>o.name.startsWith("dm_")&&o.type==="table"))db.exec(`DROP TABLE ${object.name}`);
  if(oldMap){
    for(const object of objects(db).filter(o=>o.name.startsWith("tactical_map_contexts_v2")))db.exec(`DROP ${object.type} IF EXISTS ${object.name}`);
    for(const table of ["tactical_maps_v58","tactical_map_previews_v58"]){
      const definition=expected.find(o=>o.name===table)!;
      db.exec(`DROP TABLE ${table}`);db.exec(table==="tactical_maps_v58"?definition.sql.replace(",'dungeon-v2','cave-v2','arena-v2'","")
        :definition.sql.replace("  actor_location_revision INTEGER,\n",""));
      for(const object of expected.filter(o=>o.tbl_name===table&&o.type!=="table"))db.exec(object.sql);
    }
  }
  db.pragma("foreign_keys=ON");return expected;
}
describe("exact DM schema upgrade",()=>{
  it('rebuilds only the exact historical-membership predecessor, retaining evidence and rolling back on validation failure',async()=>{
    const f=await dmFixture();f.graph();f.advance();const filename=path.join(process.env.VELVET_DATA_DIR!,'velvet.sqlite'),db=new DatabaseDriver(filename);
    db.prepare("INSERT INTO principals(id,display_name,is_local) VALUES('old-gm','Old GM',0)").run();
    f.repo.addCampaignMembership('local-owner',f.campaign.id,{principalId:'old-gm',role:'gm'});
    f.repo.setDmControl('old-gm',f.campaign.id,{mode:'ai',expectedRevision:0,idempotencyKey:'old-delegation'});
    const run=f.repo.openDmBeat('local-owner',f.campaign.id,f.session.id,{intent:'open',expectedModeRevision:1,idempotencyKey:'pending'});
    f.repo.close();const expected=objects(db);db.pragma('foreign_keys=OFF');
    for(const object of expected.filter(o=>o.name.startsWith('dm_review_')&&o.type!=='table'))db.exec(`DROP ${object.type} ${object.name}`);
    for(const object of expected.filter(o=>o.name.startsWith('dm_review_')&&o.type==='table'))db.exec(`DROP TABLE ${object.name}`);
    for(const name of ['dm_control','dm_mode_commands','dm_runs']){
      const original=expected.find(o=>o.name===name)!;
      const sql=original.sql.replace('FOREIGN KEY(delegator) REFERENCES principals(id)','FOREIGN KEY(campaign_id,delegator) REFERENCES campaign_memberships(campaign_id,principal_id)')
        .replace('FOREIGN KEY(principal_id) REFERENCES principals(id)','FOREIGN KEY(campaign_id,principal_id) REFERENCES campaign_memberships(campaign_id,principal_id)')
        .replace('FOREIGN KEY(gm_principal_id) REFERENCES principals(id)','FOREIGN KEY(campaign_id,gm_principal_id) REFERENCES campaign_memberships(campaign_id,principal_id)');
      db.exec(`CREATE TEMP TABLE saved AS SELECT * FROM ${name}`);db.exec(`DROP TABLE ${name}`);db.exec(sql);
      db.exec(`INSERT INTO ${name} SELECT * FROM saved`);db.exec('DROP TABLE saved');
      for(const object of expected.filter(o=>o.tbl_name===name&&o.type!=='table'&&!o.name.startsWith('dm_review_')))db.exec(object.sql);
    }
    db.pragma('foreign_keys=ON');const before=objects(db),command=db.prepare('SELECT * FROM dm_mode_commands').all(),request=db.prepare('SELECT request_json FROM dm_runs').all();
    expect(()=>upgradeCampaignDmSchema(db,before,expected,()=>{throw new Error('injected');})).toThrow('injected');
    expect(objects(db)).toEqual(before);expect((db.prepare('SELECT state FROM dm_runs').get() as any).state).toBe('planning');
    ensureCurrentSchema(db,filename);expect(db.prepare('SELECT * FROM dm_mode_commands').all()).toEqual(command);expect(db.prepare('SELECT request_json FROM dm_runs').all()).toEqual(request);
    expect((db.prepare('SELECT state FROM dm_runs WHERE run_id=?').get(run.runId) as any).state).toBe('cancelled');
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);db.close();
    const repo=createRepository(f.options);f.advance();repo.removeAuditedCampaignMembership('local-owner',f.campaign.id,'old-gm',{
      expectedRevision:repo.getCampaignAdministration('local-owner',f.campaign.id)!.revision,idempotencyKey:'remove-after-upgrade'});repo.close();
  });
  it('adds narration to the exact director predecessor without changing mode or prior command evidence',()=>{
    const repo=createRepository(),campaign=repo.createCampaign('local-owner',{name:'Existing director'});
    repo.setDmControl('local-owner',campaign.id,{mode:'ai',expectedRevision:0,idempotencyKey:'delegate'});repo.close();
    const filename=path.join(process.env.VELVET_DATA_DIR!,'velvet.sqlite'),db=new DatabaseDriver(filename);
    const expected=objects(db);db.pragma('foreign_keys=OFF');
    for(const object of expected.filter(o=>o.name.startsWith('dm_narration_')&&o.type!=='table'))db.exec(`DROP ${object.type} ${object.name}`);
    for(const object of expected.filter(o=>o.name.startsWith('dm_narration_')&&o.type==='table'))db.exec(`DROP TABLE ${object.name}`);
    db.pragma('foreign_keys=ON');const before=objects(db),mode=db.prepare('SELECT * FROM dm_control').all(),commands=db.prepare('SELECT * FROM dm_mode_commands').all();
    expect(()=>upgradeCampaignDmSchema(db,before,expected,()=>{throw new Error('rollback');})).toThrow('rollback');expect(objects(db)).toEqual(before);
    ensureCurrentSchema(db,filename);expect(db.prepare('SELECT * FROM dm_control').all()).toEqual(mode);
    expect(db.prepare('SELECT * FROM dm_mode_commands').all()).toEqual(commands);expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);db.close();
  });
  it('adds planning rounds to the exact composition predecessor without changing control',()=>{
    const repo=createRepository(),campaign=repo.createCampaign('local-owner',{name:'Existing composition'});repo.close();
    const filename=path.join(process.env.VELVET_DATA_DIR!,'velvet.sqlite'),db=new DatabaseDriver(filename);
    const expected=objects(db);db.pragma('foreign_keys=OFF');
    db.exec('DROP TABLE dm_planning_rounds');
    db.pragma('foreign_keys=ON');const before=objects(db),control=db.prepare('SELECT * FROM dm_control').all();
    expect(()=>upgradeCampaignDmSchema(db,before,expected,()=>{throw new Error('rollback');})).toThrow('rollback');
    expect(objects(db)).toEqual(before);
    ensureCurrentSchema(db,filename);expect(db.prepare('SELECT * FROM dm_control').all()).toEqual(control);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE name='dm_planning_rounds'").get()).toEqual({name:'dm_planning_rounds'});
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);db.close();
  });
  it.each([false,true])("preserves existing campaign and prior tactical-map chain (old map=%s)",(oldMap)=>{
    const repo=createRepository(),campaign=repo.createCampaign("local-owner",{name:"Preserved"});repo.close();
    const filename=path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"),db=new DatabaseDriver(filename);
    predecessor(db,oldMap);const before=db.prepare("SELECT * FROM campaigns").all();ensureCurrentSchema(db,filename);
    expect(db.prepare("SELECT * FROM campaigns").all()).toEqual(before);
    expect(db.prepare("SELECT * FROM dm_control WHERE campaign_id=?").get(campaign.id)).toEqual({campaign_id:campaign.id,mode:"human",revision:0,delegator:null});
    expect(db.prepare("PRAGMA foreign_key_check").all()).toEqual([]);db.close();const reopened=createRepository();expect(reopened.getDmControl("local-owner",campaign.id).mode).toBe("human");reopened.close();
  });
  it("rolls back the whole schema chain on validation failure and refuses unknown layouts",()=>{
    const repo=createRepository();repo.createCampaign("local-owner",{name:"Retained"});repo.close();
    const db=new DatabaseDriver(path.join(process.env.VELVET_DATA_DIR!,"velvet.sqlite"));const expected=predecessor(db,true),before=objects(db);
    expect(()=>upgradeCampaignDmSchema(db,before,expected,()=>{throw new Error("injected validation failure");})).toThrow("injected");
    expect(objects(db)).toEqual(before);expect(db.pragma("foreign_keys",{simple:true})).toBe(1);
    db.exec("CREATE TABLE unknown_data(value TEXT)");db.prepare("INSERT INTO unknown_data VALUES('kept')").run();const unknown=objects(db);
    expect(()=>ensureCurrentSchema(db,"test-only")).toThrow();expect(objects(db)).toEqual(unknown);expect(db.prepare("SELECT value FROM unknown_data").get()).toEqual({value:"kept"});db.close();
  });
});
