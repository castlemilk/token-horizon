// Offline source-helper reproduction with invented records only.
// A passing check reproduces the audited behavior; it is not a release pass.
import fs from 'node:fs';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
const base = new URL('./', import.meta.url);
const provenance = JSON.parse(fs.readFileSync(new URL('provenance.json',base),'utf8'));
const sourceBytes = fs.readFileSync(new URL('cloud-helpers.mjs',base));
assert.equal(crypto.createHash('sha256').update(sourceBytes).digest('hex'),provenance.snippet_files['cloud-helpers.mjs'],'source snippet hash');
const {aggregateUsageHistory,aggregateTeams,sanitizeEntry} = await import('./cloud-helpers.mjs');

const RealDate=globalThis.Date;
const fixedMs=RealDate.parse('2026-11-18T12:00:00Z');
class FixedDate extends RealDate {
  constructor(...args){super(...(args.length?args:[fixedMs]));}
  static now(){return fixedMs;}
}
let result;
try {
  globalThis.Date=FixedDate; // Clock injection only; source function bodies are unchanged.
  const today=Math.floor(fixedMs/86400000)*86400;
  const ages=[90,70,60,40,20,10,0];
  const days=ages.map(age=>today-age*86400);
  const profile={
    handle:'synthetic-person',tokensAll:100,costAll:1,tokensToday:10,tokens7d:20,
    teams:[{id:'a'.repeat(32),name:'Synthetic Team A'},{id:'b'.repeat(32),name:'Synthetic Team B'}],
    breakdown:{daily:[{day:today,tokens:10}],models:[],modelHistory:[
      {model:'synthetic-model',provider:'synthetic-provider',points:days.map(day=>({day,tokens:10}))}
    ]}
  };
  const history=aggregateUsageHistory([profile],7);
  assert.equal(history.days.length,7);
  assert.equal(history.days[0],today-90*86400);
  const teams=aggregateTeams([profile]);
  assert.equal(teams.length,2);
  assert.deepEqual(teams.map(team=>team.tokens),[100,100]);
  assert.equal(teams.reduce((sum,team)=>sum+team.tokens,0),200);
  const synthetic={handle:'synthetic-person',ownerId:'SYNTHETIC_OWNER',identityId:'SYNTHETIC_IDENTITY',claimTokenHash:'SYNTHETIC_CLAIM_HASH',googleEmail:'SYNTHETIC_EMAIL_SENTINEL',accountEmail:'SYNTHETIC_OTHER_EMAIL_SENTINEL'};
  const publicSummary=sanitizeEntry(synthetic,false);
  const publicFull=sanitizeEntry(synthetic,true);
  for(const obj of [publicSummary,publicFull]) {
    assert.equal(Object.hasOwn(obj,'googleEmail'),true);
    for(const key of ['ownerId','identityId','claimTokenHash','accountEmail']) assert.equal(Object.hasOwn(obj,key),false);
  }
  result={
    test_scope:'Offline evaluation of exact source helper excerpts with synthetic fixtures; no worker/API/server or live user tested',
    commit:provenance.commit,
    runtime:{node:process.version},
    fixed_clock:'2026-11-18T12:00:00Z',
    requested_days:7,
    input_observation_ages_days:ages,
    observed_dates_retained:history.days.length,
    earliest_retained_age_days:90,
    per_team_tokens:teams.map(team=>team.tokens),
    unique_profile_tokens:100,
    sum_of_membership_contributions:200,
    summary_retained_keys:Object.keys(publicSummary),
    full_retained_keys:Object.keys(publicFull),
    checks:'PASS — audited behavior reproduced; not a production correctness or privacy certification',
    privacy_boundary:'Only field names are emitted. Email sentinel retention is a source-level allowlist gap, not evidence of any production disclosure.'
  };
} finally { globalThis.Date=RealDate; }
const json=JSON.stringify(result,null,2)+'\n';
fs.writeFileSync(new URL('cloud-results.json',base),json);
process.stdout.write(json);
