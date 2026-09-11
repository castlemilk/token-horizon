/**
 * Token Horizon Leaderboard MCP Tools
 * Connects MCP clients to Token Horizon's edge leaderboard and local macOS daemon.
 */

export const DEFAULT_API_BASE = "https://tokens.benebsworth.com";
export const DEFAULT_DAEMON_BASE = "http://127.0.0.1:8765";

function getApiBase() {
  return (process.env.TOKEN_HORIZON_API_BASE || DEFAULT_API_BASE).replace(/\/+$/, "");
}

function getDaemonBase() {
  return (process.env.TOKEN_HORIZON_DAEMON_BASE || DEFAULT_DAEMON_BASE).replace(/\/+$/, "");
}

function formatTokens(n) {
  const num = Number(n) || 0;
  if (num >= 1e9) return (num / 1e9).toFixed(2) + "B";
  if (num >= 1e6) return (num / 1e6).toFixed(1) + "M";
  if (num >= 1e3) return (num / 1e3).toFixed(0) + "K";
  return num.toLocaleString();
}

function formatCurrency(n) {
  const num = Number(n) || 0;
  if (num >= 1000) return "$" + Math.round(num).toLocaleString();
  return "$" + num.toFixed(2);
}

/**
 * 1. get_leaderboard
 */
export async function runGetLeaderboard({ period = "today", team = "", limit = 20 }) {
  const apiBase = getApiBase();
  const url = new URL(`${apiBase}/api/leaderboard`);
  url.searchParams.set("period", period);
  if (team) url.searchParams.set("team", team);

  const res = await fetch(url.toString(), {
    headers: { "Accept": "application/json" }
  });

  if (!res.ok) {
    throw new Error(`Failed to fetch leaderboard (${res.status} ${res.statusText})`);
  }

  const data = await res.json();
  const entries = (data.leaderboard || []).slice(0, Math.min(100, Math.max(1, limit)));

  const kpis = data.kpis || {};
  let summary = `🏆 **Token Horizon Leaderboard** [${(data.period || period).toUpperCase()}]`;
  if (data.team) summary += ` (Team: ${data.team})`;
  summary += `\n- **Total Tokens**: ${kpis.totalTokensFormatted || formatTokens(kpis.totalTokens || 0)}`;
  summary += `\n- **Total Cost**: ${kpis.totalCostFormatted || formatCurrency(kpis.totalCost || 0)}`;
  summary += `\n- **Active Devs**: ${kpis.activeDevs || entries.length}`;
  summary += `\n- **Top Streak**: 🔥 ${kpis.maxStreakDays || 0}d\n\n`;

  let table = "| Rank | Participant | Tokens | Cost | Streak | Top Model | Status |\n";
  table += "| :--- | :--- | :--- | :--- | :--- | :--- | :--- |\n";

  entries.forEach(e => {
    const item = e.entry || {};
    const status = item.claimed ? "✓ Verified" : "Unclaimed";
    const topModel = item.topModel || "claude-opus-5";
    const streak = item.streakDays ? `🔥 ${item.streakDays}d` : "—";
    table += `| ${e.badge || '#' + e.rank} | **@${item.handle}** | ${e.scoreFormatted || formatTokens(e.score)} | ${e.costFormatted || formatCurrency(item.costToday)} | ${streak} | \`${topModel}\` | ${status} |\n`;
  });

  return {
    raw: data,
    summary,
    table,
    text: summary + table
  };
}

/**
 * 2. get_user_profile
 */
export async function runGetUserProfile({ handle }) {
  if (!handle) throw new Error("Missing required parameter: handle");
  const cleanHandle = handle.replace(/^@/, "").trim().toLowerCase();
  const apiBase = getApiBase();

  const res = await fetch(`${apiBase}/api/user/${encodeURIComponent(cleanHandle)}`, {
    headers: { "Accept": "application/json" }
  });

  if (res.status === 404) {
    return {
      found: false,
      handle: cleanHandle,
      text: `Participant @${cleanHandle} was not found on the leaderboard.`
    };
  }

  if (!res.ok) {
    throw new Error(`Failed to fetch user profile (${res.status} ${res.statusText})`);
  }

  const data = await res.json();
  const entry = data.entry || {};
  const bd = entry.breakdown || {};
  const ranks = data.ranks || {};

  let text = `👤 **Profile: @${entry.handle}**\n`;
  text += `- **Rankings**: Today #${ranks.today || '—'} | Week #${ranks.week || '—'} | All-Time #${ranks.all || '—'} | Streak #${ranks.streak || '—'}\n`;
  text += `- **Status**: ${entry.claimed ? `✓ Verified (${entry.googleEmail || 'Google'})` : 'Unclaimed (can be claimed via claim_profile)'}\n`;
  text += `- **Hardware**: ${entry.hardware || 'Apple Silicon'}\n`;
  text += `- **Team**: ${entry.team || 'Personal'}\n`;
  text += `- **Streak**: 🔥 ${entry.streakDays || 0} days\n\n`;

  text += `📊 **Volume & Cost KPIs**:\n`;
  text += `- **Today**: ${formatTokens(entry.tokensToday || 0)} (${formatCurrency(entry.costToday || 0)})\n`;
  text += `- **7-Day**: ${formatTokens(entry.tokens7d || 0)} (${formatCurrency(entry.cost7d || 0)})\n`;
  text += `- **All-Time**: ${formatTokens(entry.tokensAll || 0)} (${formatCurrency(entry.costAll || 0)})\n\n`;

  // Models breakdown
  const models = bd.models || [];
  if (models.length > 0) {
    text += `🤖 **Model Inventory (${models.length} active models)**:\n`;
    text += "| Provider | Model | Today | All-Time | Cost | Share |\n";
    text += "| :--- | :--- | :--- | :--- | :--- | :--- |\n";
    models.slice(0, 15).forEach(m => {
      const share = Number(m.sharePercent || 0).toFixed(1);
      text += `| ${m.provider || 'ai'} | \`${m.model}\` | ${formatTokens(m.tokensToday || 0)} | ${formatTokens(m.tokensAll || 0)} | ${formatCurrency(m.costAll || m.costToday || 0)} | ${share}% |\n`;
    });
    if (models.length > 15) {
      text += `_...and ${models.length - 15} more models_\n`;
    }
    text += "\n";
  }

  // Tools breakdown
  const tools = bd.tools || [];
  if (tools.length > 0) {
    text += `🛠️ **Telemetry Tools**:\n`;
    tools.forEach(t => {
      text += `- **${t.tool}**: ${formatTokens(t.tokensAll || t.tokensToday || 0)} tokens (${formatCurrency(t.costAll || t.costToday || 0)})\n`;
    });
    text += "\n";
  }

  // Activity History
  const history = bd.history || [];
  if (history.length > 0) {
    text += `📅 **7-Day Activity History**:\n`;
    history.forEach(h => {
      text += `- **${h.dayLabel || 'Day'}**: ${formatTokens(h.tokens)} (${formatCurrency(h.cost || 0)})\n`;
    });
  }

  return {
    found: true,
    data,
    text
  };
}

/**
 * 3. get_daemon_metrics
 */
export async function runGetDaemonMetrics() {
  const daemonBase = getDaemonBase();

  try {
    const res = await fetch(`${daemonBase}/leaderboard`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) {
      throw new Error(`Daemon returned ${res.status}`);
    }
    const data = await res.json();
    const userRank = data.userRank || {};
    const entry = userRank.entry || {};

    let text = `⚡ **Token Horizon Local Daemon Status: ONLINE**\n`;
    text += `Target: ${daemonBase}\n`;
    text += `- **Handle**: @${entry.handle || 'unknown'}\n`;
    text += `- **Today's Volume**: ${formatTokens(entry.tokensToday || 0)} (${formatCurrency(entry.costToday || 0)})\n`;
    text += `- **7-Day Volume**: ${formatTokens(entry.tokens7d || 0)} (${formatCurrency(entry.cost7d || 0)})\n`;
    text += `- **All-Time Volume**: ${formatTokens(entry.tokensAll || 0)} (${formatCurrency(entry.costAll || 0)})\n`;
    text += `- **Primary Model**: \`${entry.topModel || 'unknown'}\`\n`;
    text += `- **Hardware**: ${entry.hardware || 'Apple Silicon'}\n`;
    text += `- **Streak**: 🔥 ${entry.streakDays || 0} days\n`;
    text += `- **Active Tools Tracked**: ${(entry.breakdown?.tools || []).map(t => t.tool).join(", ") || "none"}\n`;
    text += `- **Active Models Tracked**: ${(entry.breakdown?.models || []).length} models\n`;

    return {
      online: true,
      daemonBase,
      entry,
      raw: data,
      text
    };
  } catch (err) {
    return {
      online: false,
      daemonBase,
      error: err.message,
      text: `⚠️ **Token Horizon Local Daemon is OFFLINE** (${daemonBase})\nError: ${err.message}\nEnsure the Token Horizon macOS app or daemon is running on port 8765.`
    };
  }
}

/**
 * 4. publish_telemetry
 */
export async function runPublishTelemetry({ from_daemon = true, entry, claim_token, google_token }) {
  const apiBase = getApiBase();
  let payload = entry;

  if (from_daemon) {
    const daemonBase = getDaemonBase();
    const daemonRes = await fetch(`${daemonBase}/leaderboard`, { signal: AbortSignal.timeout(3000) });
    if (!daemonRes.ok) throw new Error(`Could not fetch from local daemon (${daemonRes.status})`);
    const daemonData = await daemonRes.json();
    payload = daemonData.userRank?.entry;
    if (!payload || !payload.handle) throw new Error("Local daemon did not return a valid user entry");
  }

  if (!payload || !payload.handle) {
    throw new Error("Missing payload or payload.handle to publish");
  }

  const headers = {
    "Content-Type": "application/json"
  };
  if (claim_token) headers["X-Claim-Token"] = claim_token;
  if (google_token) headers["X-Google-Token"] = google_token;

  const res = await fetch(`${apiBase}/api/leaderboard`, {
    method: "POST",
    headers,
    body: JSON.stringify(payload)
  });

  const resData = await res.json();
  if (!res.ok) {
    throw new Error(`Publish failed (${res.status}): ${resData.error || res.statusText}`);
  }

  let text = `🚀 **Telemetry Successfully Published!**\n`;
  text += `- **Handle**: @${resData.handle}\n`;
  text += `- **Action**: ${resData.action}\n`;
  text += `- **Status**: ${resData.claimed ? '✓ Verified (Google Bound)' : 'Unclaimed'}\n`;
  if (resData.claimToken) {
    text += `- **Claim Token**: \`${resData.claimToken}\` (Save this secret to update anonymously without Google!)\n`;
  }
  text += `- **Total Entries on Board**: ${resData.totalEntries}\n`;
  text += `- **Live Leaderboard URL**: ${apiBase}/leaderboard.html?user=${encodeURIComponent(resData.handle)}\n`;

  return {
    success: true,
    result: resData,
    text
  };
}

/**
 * 5. claim_profile
 */
export async function runClaimProfile({ handle, google_token, claim_token }) {
  if (!handle) throw new Error("Missing handle");
  if (!google_token) throw new Error("Missing google_token");

  const apiBase = getApiBase();
  const cleanHandle = handle.replace(/^@/, "").trim().toLowerCase();

  const res = await fetch(`${apiBase}/api/claim`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      handle: cleanHandle,
      googleToken: google_token,
      claimToken: claim_token
    })
  });

  const resData = await res.json();
  if (!res.ok) {
    throw new Error(`Claim failed (${res.status}): ${resData.error || res.statusText}`);
  }

  let text = `⭐ **Profile Successfully Claimed & Verified!**\n`;
  text += `- **Handle**: @${cleanHandle}\n`;
  text += `- **Google Account**: ${resData.googleEmail || 'Verified'}\n`;
  text += `- **Verified Badge**: Active ✓\n`;
  text += `- **Profile URL**: ${apiBase}/leaderboard.html?user=${encodeURIComponent(cleanHandle)}\n`;

  return {
    success: true,
    result: resData,
    text
  };
}

/**
 * 6. compare_users
 */
export async function runCompareUsers({ user1, user2 }) {
  if (!user1 || !user2) throw new Error("Both user1 and user2 are required");

  const p1 = await runGetUserProfile({ handle: user1 });
  const p2 = await runGetUserProfile({ handle: user2 });

  if (!p1.found) throw new Error(`User @${user1} not found`);
  if (!p2.found) throw new Error(`User @${user2} not found`);

  const e1 = p1.data.entry || {};
  const e2 = p2.data.entry || {};

  const costPerM1 = e1.tokensAll > 0 ? ((e1.costAll / (e1.tokensAll / 1e6))).toFixed(2) : "0.00";
  const costPerM2 = e2.tokensAll > 0 ? ((e2.costAll / (e2.tokensAll / 1e6))).toFixed(2) : "0.00";

  let text = `⚔️ **Token Horizon Comparison: @${e1.handle} vs @${e2.handle}**\n\n`;
  text += "| Metric | @" + e1.handle + " | @" + e2.handle + " | Advantage |\n";
  text += "| :--- | :--- | :--- | :--- |\n";

  const diffTokensToday = (e1.tokensToday || 0) - (e2.tokensToday || 0);
  const advToday = diffTokensToday > 0 ? `@${e1.handle} (+${formatTokens(diffTokensToday)})` : diffTokensToday < 0 ? `@${e2.handle} (+${formatTokens(-diffTokensToday)})` : "Tied";
  text += `| **Tokens Today** | ${formatTokens(e1.tokensToday || 0)} | ${formatTokens(e2.tokensToday || 0)} | ${advToday} |\n`;

  const diffTokens7d = (e1.tokens7d || 0) - (e2.tokens7d || 0);
  const adv7d = diffTokens7d > 0 ? `@${e1.handle} (+${formatTokens(diffTokens7d)})` : diffTokens7d < 0 ? `@${e2.handle} (+${formatTokens(-diffTokens7d)})` : "Tied";
  text += `| **7-Day Tokens** | ${formatTokens(e1.tokens7d || 0)} | ${formatTokens(e2.tokens7d || 0)} | ${adv7d} |\n`;

  const diffTokensAll = (e1.tokensAll || 0) - (e2.tokensAll || 0);
  const advAll = diffTokensAll > 0 ? `@${e1.handle} (+${formatTokens(diffTokensAll)})` : diffTokensAll < 0 ? `@${e2.handle} (+${formatTokens(-diffTokensAll)})` : "Tied";
  text += `| **All-Time Tokens** | ${formatTokens(e1.tokensAll || 0)} | ${formatTokens(e2.tokensAll || 0)} | ${advAll} |\n`;

  text += `| **Total Spend** | ${formatCurrency(e1.costAll || 0)} | ${formatCurrency(e2.costAll || 0)} | — |\n`;
  text += `| **Effective $/M Tokens** | $${costPerM1}/M | $${costPerM2}/M | ${Number(costPerM1) <= Number(costPerM2) ? '@' + e1.handle : '@' + e2.handle} (lower) |\n`;

  const streakDiff = (e1.streakDays || 0) - (e2.streakDays || 0);
  const advStreak = streakDiff > 0 ? `@${e1.handle}` : streakDiff < 0 ? `@${e2.handle}` : "Tied";
  text += `| **Active Streak** | 🔥 ${e1.streakDays || 0}d | 🔥 ${e2.streakDays || 0}d | ${advStreak} |\n`;
  text += `| **Top Model** | \`${e1.topModel || 'n/a'}\` | \`${e2.topModel || 'n/a'}\` | — |\n`;
  text += `| **Hardware** | ${e1.hardware || 'Apple Silicon'} | ${e2.hardware || 'Apple Silicon'} | — |\n`;
  text += `| **Status** | ${e1.claimed ? '✓ Verified' : 'Unclaimed'} | ${e2.claimed ? '✓ Verified' : 'Unclaimed'} | — |\n`;

  return {
    user1: e1,
    user2: e2,
    text
  };
}
