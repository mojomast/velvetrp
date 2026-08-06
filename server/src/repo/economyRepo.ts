import type DatabaseDriver from "better-sqlite3";
import { economyCommandSchema, purchaseReceiptSchema, purchaseQuoteSchema, resourceIdSchema, shopSchema, walletSchema, type BilateralTrade, type EconomyCommand, type Shop, type Wallet } from "@velvet/contracts";
import { ActorResourceConflictError, ActorResourceNegativeError, getM15ActorRevision, m15Authorized, runM15Mutation, type M15Dependencies, type M15Result } from "./actorResourceRepo.js";

export class EconomyAuthorizationError extends Error { readonly code="ECONOMY_FORBIDDEN"; }
export class ShopStockExhaustedError extends Error { readonly code="SHOP_STOCK_EXHAUSTED"; }
export class QuoteExpiredError extends Error { readonly code="QUOTE_EXPIRED"; }
export class TradeStaleError extends Error { readonly code="TRADE_STALE"; }
export class EconomyConflictError extends Error { readonly code="ECONOMY_CONFLICT"; }
const MAX_MINOR=Number.MAX_SAFE_INTEGER;
const totalFor=(quantity:number,unitPrice:number):number=>{
  if(quantity>Math.floor(MAX_MINOR/unitPrice))throw new EconomyConflictError("quote total exceeds supported currency range");
  return quantity*unitPrice;
};
export interface ActorEconomySnapshot { campaignId:string; actorId:string; wallet:Wallet; revision:number; }
export type ActorScopedEconomyCommand=
  |{kind:"request_purchase_quote";shopId:string;item:{kind:"item";packId:string;packVersion:string;definitionId:string};quantity:number;expectedRevision:number;idempotencyKey:string}
  |{kind:"purchase_from_shop";quoteId:string;expectedRevision:number;idempotencyKey:string}
  |{kind:"propose_bilateral_trade";trade:Omit<BilateralTrade,"campaignId"|"offeredByActorId">;expectedRevision:number;idempotencyKey:string}
  |{kind:"accept_bilateral_trade";tradeId:string;expectedRevision:number;idempotencyKey:string}
  |{kind:"cancel_bilateral_trade";tradeId:string;expectedRevision:number;idempotencyKey:string};
export interface EconomyRepository {
  getWallet(principal:string,campaignId:string,actorId:string):Wallet|null;
  getActorEconomySnapshot(principal:string,campaignId:string,actorId:string):ActorEconomySnapshot|null;
  getShop(principal:string,campaignId:string,shopId:string):Shop|null;
  mutateEconomy(principal:string,command:EconomyCommand):M15Result<{quote?:object;purchase?:object;trade?:object}>;
  mutateEconomyForActor(principal:string,campaignId:string,actorId:string,input:ActorScopedEconomyCommand):M15Result<{quote?:object;purchase?:object;trade?:object}>;
}

/** Currency codes are legacy storage keys.  The v25 reference sidecar is the
 * authoritative public projection and prevents a code from silently meaning a
 * different pinned definition. */
export function createEconomyRepository(db:DatabaseDriver.Database,deps:M15Dependencies,assertMutation:()=>void):EconomyRepository {
  const ref=(campaign:string,code:string)=>db.prepare("SELECT 'currency' kind,pack_id packId,pack_version packVersion,definition_id definitionId FROM rpg_currency_references_v25 WHERE campaign_id=? AND currency_code=?").get(campaign,code) as any;
  const wallet=(principal:string,campaign:string,actor:string):Wallet|null=>{
    resourceIdSchema.parse(principal); resourceIdSchema.parse(campaign); resourceIdSchema.parse(actor);
    if(!m15Authorized(db,principal,campaign,actor)) return null;
    const balances=(db.prepare("SELECT currency_code,balance_minor FROM rpg_wallets_v25 WHERE campaign_id=? AND actor_id=? ORDER BY currency_code").all(campaign,actor) as any[]).map(row=>({currency:ref(campaign,row.currency_code),minorUnits:row.balance_minor}));
    if(balances.some(row=>!row.currency)) return null; // never fabricate an exact reference
    return walletSchema.parse({balances});
  };
  const snapshot=(principal:string,campaign:string,actor:string):ActorEconomySnapshot|null=>db.transaction(()=>{
    resourceIdSchema.parse(principal);resourceIdSchema.parse(campaign);resourceIdSchema.parse(actor);
    if(!m15Authorized(db,principal,campaign,actor))return null;
    const current=wallet(principal,campaign,actor);
    return current?{campaignId:campaign,actorId:actor,wallet:current,revision:getM15ActorRevision(db,campaign,actor)}:null;
  })();
  const shop=(principal:string,campaign:string,shopId:string):Shop|null=>{
    resourceIdSchema.parse(principal);resourceIdSchema.parse(campaign);resourceIdSchema.parse(shopId);
    if(!db.prepare("SELECT 1 FROM campaign_memberships WHERE campaign_id=? AND principal_id=?").get(campaign,principal)) return null;
    const definition=db.prepare("SELECT name FROM rpg_shop_definitions_v25 WHERE campaign_id=? AND shop_id=?").get(campaign,shopId) as any;if(!definition)return null;
    const stock=(db.prepare("SELECT * FROM rpg_shop_stock_v25 WHERE campaign_id=? AND shop_id=? ORDER BY stock_id").all(campaign,shopId)as any[]).map(row=>({item:{kind:'item',packId:row.item_pack_id,packVersion:row.item_pack_version,definitionId:row.item_definition_id},quantity:row.available_quantity,unitPrice:{currency:ref(campaign,row.currency_code),minorUnits:row.unit_price_minor}}));
    if(stock.some(row=>!row.unitPrice.currency))return null;
    return shopSchema.parse({shopId,campaignId:campaign,name:definition.name,stock});
  };
  const walletRow=(campaign:string,actor:string,code:string)=>db.prepare("SELECT balance_minor FROM rpg_wallets_v25 WHERE campaign_id=? AND actor_id=? AND currency_code=?").get(campaign,actor,code)as any;
  const debit=(campaign:string,actor:string,code:string,amount:number,now:string,id:string,reason:string)=>{
    const row=walletRow(campaign,actor,code);if(!row||row.balance_minor<amount)throw new ActorResourceNegativeError("wallet cannot become negative");
    db.prepare("UPDATE rpg_wallets_v25 SET balance_minor=balance_minor-?,updated_at=? WHERE campaign_id=? AND actor_id=? AND currency_code=?").run(amount,now,campaign,actor,code);
    db.prepare("INSERT INTO rpg_currency_ledger_v25(entry_id,campaign_id,actor_id,currency_code,delta_minor,reason,reference_type,reference_id,occurred_at) VALUES(?,?,?,?,? ,?,?,?,?)").run(id,campaign,actor,code,-amount,reason,reason,id,now);
  };
  const mutateEconomy=(principal:string,input:EconomyCommand)=>{const command=economyCommandSchema.parse(input);const actor='buyerActorId'in command?command.buyerActorId:'trade'in command?command.trade.offeredByActorId:'acceptedByActorId'in command?command.acceptedByActorId:command.cancelledByActorId;
    const existingTrade=(command.type==='accept_bilateral_trade'||command.type==='cancel_bilateral_trade')
      ?db.prepare("SELECT proposer_actor_id,recipient_actor_id FROM rpg_trade_proposals_v25 WHERE campaign_id=? AND trade_id=?").get(command.campaignId,command.tradeId)as any:undefined;
    const counterpart=command.type==='propose_bilateral_trade'?command.trade.acceptedByActorId:existingTrade
      ?(actor===existingTrade.proposer_actor_id?existingTrade.recipient_actor_id:existingTrade.proposer_actor_id):undefined;
    return runM15Mutation(db,deps,assertMutation,{principal,campaignId:command.campaignId,actorId:actor,family:command.type==='purchase_from_shop'?'purchase':command.type.includes('trade')?'trade':'economy',type:command.type,expectedRevision:command.expectedRevision,idempotencyKey:command.idempotencyKey,request:command,changedKeys:[`economy:${actor}`],additionalActorIds:counterpart?[counterpart]:[],apply:(_after,now,commandId)=>{
      if(command.type==='request_purchase_quote'){
        const stock=db.prepare("SELECT * FROM rpg_shop_stock_v25 WHERE campaign_id=? AND shop_id=? AND item_pack_id=? AND item_pack_version=? AND item_definition_id=?").get(command.campaignId,command.shopId,command.item.packId,command.item.packVersion,command.item.definitionId)as any;
        if(!stock||stock.available_quantity<command.quantity)throw new ShopStockExhaustedError('shop stock exhausted');if(!ref(command.campaignId,stock.currency_code))throw new EconomyConflictError('currency has no pinned reference');const total=totalFor(command.quantity,stock.unit_price_minor);
        const expires=new Date(new Date(now).getTime()+300000).toISOString();db.prepare("INSERT INTO rpg_shop_quotes_v25 VALUES(?,?,?,?,?,?,?,?,?,?)").run(commandId,command.campaignId,stock.stock_id,command.shopId,actor,command.quantity,stock.unit_price_minor,stock.currency_code,now,expires);
        return {quote:purchaseQuoteSchema.parse({quoteId:commandId,campaignId:command.campaignId,shopId:command.shopId,buyerActorId:actor,item:command.item,quantity:command.quantity,total:{currency:ref(command.campaignId,stock.currency_code),minorUnits:total},expiresAt:expires})};
      }
      if(command.type==='purchase_from_shop'){
        const quote=db.prepare("SELECT quote.*,stock.shop_id,stock.available_quantity,stock.item_pack_id,stock.item_pack_version,stock.item_definition_id FROM rpg_shop_quotes_v25 quote JOIN rpg_shop_stock_v25 stock ON stock.stock_id=quote.stock_id WHERE quote.quote_id=? AND quote.campaign_id=? AND quote.actor_id=?").get(command.quoteId,command.campaignId,actor)as any;
        if(!quote)throw new EconomyConflictError('quote unavailable');if(quote.expires_at<=now)throw new QuoteExpiredError('quote expired');if(quote.available_quantity<quote.quantity)throw new ShopStockExhaustedError('shop stock exhausted');
        const existing=db.prepare("SELECT entry_id FROM rpg_inventory_entries_v25 WHERE campaign_id=? AND actor_id=? AND entry_mode='stackable' AND item_pack_id=? AND item_pack_version=? AND item_definition_id=?").get(command.campaignId,actor,quote.item_pack_id,quote.item_pack_version,quote.item_definition_id)as any;
        if(!existing){const cap=(db.prepare("SELECT max FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='inventory-capacity'").get(command.campaignId,actor)as any)?.max??1000;const count=(db.prepare("SELECT count(*) count FROM rpg_inventory_entries_v25 WHERE campaign_id=? AND actor_id=?").get(command.campaignId,actor)as any).count;if(count>=cap)throw new EconomyConflictError('inventory capacity is full');}
        const total=totalFor(quote.quantity,quote.unit_price_minor);debit(command.campaignId,actor,quote.currency_code,total,now,commandId,'purchase');db.prepare("UPDATE rpg_shop_stock_v25 SET available_quantity=available_quantity-? WHERE stock_id=?").run(quote.quantity,quote.stock_id);
        if(existing)db.prepare("UPDATE rpg_inventory_entries_v25 SET quantity=quantity+? WHERE entry_id=?").run(quote.quantity,existing.entry_id);else db.prepare("INSERT INTO rpg_inventory_entries_v25(entry_id,campaign_id,actor_id,item_pack_id,item_pack_version,item_kind,item_definition_id,entry_mode,quantity,instance_key,slot_key,equipped,created_at) VALUES(?,?,?,?,?,'item',?,'stackable',?,NULL,NULL,0,?)").run(deps.ids.nextId(),command.campaignId,actor,quote.item_pack_id,quote.item_pack_version,quote.item_definition_id,quote.quantity,now);
        db.prepare("INSERT INTO rpg_purchase_receipts_v25 VALUES(?,?,?,?,?,?,?,?,?,?,?)").run(commandId,command.quoteId,command.campaignId,quote.shop_id,actor,commandId,_after,quote.quantity,JSON.stringify({currency:ref(command.campaignId,quote.currency_code),minorUnits:total}),now,command.idempotencyKey);
        return {purchase:purchaseReceiptSchema.parse({purchaseId:commandId,quoteId:command.quoteId,campaignId:command.campaignId,shopId:quote.shop_id,buyerActorId:actor,quantity:quote.quantity,total:{currency:ref(command.campaignId,quote.currency_code),minorUnits:total},purchasedAt:now,revisionBefore:command.expectedRevision,revisionAfter:_after,idempotencyKey:command.idempotencyKey})};
      }
      if(command.type==='propose_bilateral_trade'){db.prepare("INSERT INTO rpg_trade_proposals_v25 VALUES(?,?,? ,?,'open',?,?,?,?)").run(command.trade.tradeId,command.campaignId,command.trade.offeredByActorId,command.trade.acceptedByActorId,JSON.stringify(command.trade),JSON.stringify(command.trade),now,new Date(new Date(now).getTime()+300000).toISOString());return {trade:{tradeId:command.trade.tradeId,status:'open'}};}
      const trade=db.prepare("SELECT * FROM rpg_trade_proposals_v25 WHERE trade_id=? AND campaign_id=?").get(command.tradeId,command.campaignId)as any;if(!trade||trade.status!=='open')throw new TradeStaleError('trade is not open');if(trade.expires_at<=now){db.prepare("UPDATE rpg_trade_proposals_v25 SET status='cancelled' WHERE trade_id=?").run(command.tradeId);return {trade:{tradeId:command.tradeId,status:'cancelled',expired:true}};}
      if(command.type==='cancel_bilateral_trade'){if(actor!==trade.proposer_actor_id&&actor!==trade.recipient_actor_id)throw new EconomyAuthorizationError('not a trade party');db.prepare("UPDATE rpg_trade_proposals_v25 SET status='cancelled' WHERE trade_id=?").run(command.tradeId);return {trade:{tradeId:command.tradeId,status:'cancelled'}};}
      if(actor!==trade.recipient_actor_id)throw new EconomyAuthorizationError('only recipient may accept');
      const terms=JSON.parse(trade.offer_json) as any;
      const moveItems=(from:string,to:string,lines:any[])=>{for(const line of lines){
        // Tagged lines are exact selections.  In particular, never choose an
        // arbitrary matching instance merely because its catalog item matches.
        const source=('kind'in line)
          ?db.prepare("SELECT * FROM rpg_inventory_entries_v25 WHERE entry_id=? AND campaign_id=? AND actor_id=? AND item_pack_id=? AND item_pack_version=? AND item_definition_id=? AND entry_mode=? AND equipped=0").get(line.entryId,command.campaignId,from,line.item.packId,line.item.packVersion,line.item.definitionId,line.kind)as any
          :db.prepare("SELECT * FROM rpg_inventory_entries_v25 WHERE campaign_id=? AND actor_id=? AND item_pack_id=? AND item_pack_version=? AND item_definition_id=? AND entry_mode='stackable' AND equipped=0 ORDER BY created_at LIMIT 1").get(command.campaignId,from,line.item.packId,line.item.packVersion,line.item.definitionId)as any;
        const quantity='kind'in line&&line.kind==='instanced'?1:line.quantity;
        if(!source||source.quantity<quantity)throw new EconomyConflictError('trade inventory is unavailable');
        const destination=db.prepare("SELECT entry_id FROM rpg_inventory_entries_v25 WHERE campaign_id=? AND actor_id=? AND entry_mode='stackable' AND item_pack_id=? AND item_pack_version=? AND item_definition_id=?").get(command.campaignId,to,source.item_pack_id,source.item_pack_version,source.item_definition_id)as any;
        if(!destination){const cap=(db.prepare("SELECT max FROM rpg_actor_resources WHERE campaign_id=? AND actor_id=? AND name='inventory-capacity'").get(command.campaignId,to)as any)?.max??1000;const used=(db.prepare("SELECT count(*) count FROM rpg_inventory_entries_v25 WHERE campaign_id=? AND actor_id=?").get(command.campaignId,to)as any).count;if(used>=cap)throw new EconomyConflictError('trade destination inventory is full');}
        if(source.entry_mode==='instanced'){db.prepare("UPDATE rpg_inventory_entries_v25 SET actor_id=?,slot_key=NULL,equipped=0 WHERE entry_id=?").run(to,source.entry_id);}
        else {db.prepare("UPDATE rpg_inventory_entries_v25 SET quantity=quantity-? WHERE entry_id=?").run(quantity,source.entry_id);db.prepare("DELETE FROM rpg_inventory_entries_v25 WHERE entry_id=? AND quantity=0").run(source.entry_id);if(destination)db.prepare("UPDATE rpg_inventory_entries_v25 SET quantity=quantity+? WHERE entry_id=?").run(quantity,destination.entry_id);else db.prepare("INSERT INTO rpg_inventory_entries_v25(entry_id,campaign_id,actor_id,item_pack_id,item_pack_version,item_kind,item_definition_id,entry_mode,quantity,instance_key,slot_key,equipped,created_at) VALUES(?,?,?,?,?,'item',?,'stackable',?,NULL,NULL,0,?)").run(deps.ids.nextId(),command.campaignId,to,source.item_pack_id,source.item_pack_version,source.item_definition_id,quantity,now);}
      }};
      const moveCurrency=(from:string,to:string,amounts:any[])=>{for(const amount of amounts){const codeRow=db.prepare("SELECT currency_code FROM rpg_currency_references_v25 WHERE campaign_id=? AND pack_id=? AND pack_version=? AND definition_id=?").get(command.campaignId,amount.currency.packId,amount.currency.packVersion,amount.currency.definitionId)as any;if(!codeRow)throw new EconomyConflictError('trade currency is not pinned');debit(command.campaignId,from,codeRow.currency_code,amount.minorUnits,now,deps.ids.nextId(),'trade');const target=walletRow(command.campaignId,to,codeRow.currency_code);if(!target)throw new EconomyConflictError('trade recipient wallet is unavailable');db.prepare("UPDATE rpg_wallets_v25 SET balance_minor=balance_minor+?,updated_at=? WHERE campaign_id=? AND actor_id=? AND currency_code=?").run(amount.minorUnits,now,command.campaignId,to,codeRow.currency_code);db.prepare("INSERT INTO rpg_currency_ledger_v25(entry_id,campaign_id,actor_id,currency_code,delta_minor,reason,reference_type,reference_id,occurred_at) VALUES(?,?,?,?,?,'trade','trade',?,?)").run(deps.ids.nextId(),command.campaignId,to,codeRow.currency_code,amount.minorUnits,command.tradeId,now);}};
      moveItems(trade.proposer_actor_id,trade.recipient_actor_id,terms.offeredItems);moveItems(trade.recipient_actor_id,trade.proposer_actor_id,terms.requestedItems);moveCurrency(trade.proposer_actor_id,trade.recipient_actor_id,terms.offeredCurrency);moveCurrency(trade.recipient_actor_id,trade.proposer_actor_id,terms.requestedCurrency);
      db.prepare("UPDATE rpg_trade_proposals_v25 SET status='settled' WHERE trade_id=?").run(command.tradeId);db.prepare("INSERT INTO rpg_trade_settlement_receipts_v25 VALUES(?,?,?,?,?)").run(commandId,command.tradeId,command.campaignId,JSON.stringify({tradeId:command.tradeId}),now);return {trade:{tradeId:command.tradeId,status:'settled'}};
    }});
    };
  const mutateForActor=(principal:string,campaignId:string,actorId:string,input:ActorScopedEconomyCommand)=>{
    const command:EconomyCommand=input.kind==="request_purchase_quote"
      ?{type:"request_purchase_quote",campaignId,buyerActorId:actorId,shopId:input.shopId,item:input.item,quantity:input.quantity,expectedRevision:input.expectedRevision,idempotencyKey:input.idempotencyKey}
      :input.kind==="purchase_from_shop"
        ?{type:"purchase_from_shop",campaignId,buyerActorId:actorId,quoteId:input.quoteId,expectedRevision:input.expectedRevision,idempotencyKey:input.idempotencyKey}
        :input.kind==="propose_bilateral_trade"
          ?{type:"propose_bilateral_trade",campaignId,trade:{...input.trade,campaignId,offeredByActorId:actorId},expectedRevision:input.expectedRevision,idempotencyKey:input.idempotencyKey}
          :input.kind==="accept_bilateral_trade"
            ?{type:"accept_bilateral_trade",campaignId,tradeId:input.tradeId,acceptedByActorId:actorId,expectedRevision:input.expectedRevision,idempotencyKey:input.idempotencyKey}
            :{type:"cancel_bilateral_trade",campaignId,tradeId:input.tradeId,cancelledByActorId:actorId,expectedRevision:input.expectedRevision,idempotencyKey:input.idempotencyKey};
    return mutateEconomy(principal,command);
  };
  return {getWallet:wallet,getActorEconomySnapshot:snapshot,getShop:shop,mutateEconomy,mutateEconomyForActor:mutateForActor};
}
