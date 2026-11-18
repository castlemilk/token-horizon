#!/usr/bin/env python3
"""Build original offline Track 5 wireframes from one synthetic data definition.
No repository source or private usage is embedded. Standard library only.
"""
from pathlib import Path
from html import escape
import json, textwrap

OUT = Path(__file__).resolve().parent
(OUT / "visuals").mkdir(exist_ok=True)
DAYS = ["2026-11-11", "2026-11-12", "2026-11-13", "2026-11-14", "2026-11-15", "2026-11-16", "2026-11-17"]
STATUSES = ["reported", "reported", "partial", "unknown", "reported_zero", "reported", "partial"]
SELF_STATUSES = ["reported", "reported", "reported", "unknown", "reported_zero", "reported", "reported"]
DATA = {
    "label": "PROPOSAL • SYNTHETIC DATA • NOT IMPLEMENTED",
    "range": {"start_inclusive": "2026-11-11T00:00:00Z", "end_exclusive": "2026-11-18T00:00:00Z", "timezone": "UTC", "granularity": "day", "as_of": "2026-11-18T06:00:00Z"},
    "team": {"tenant_id": "synthetic_tenant", "team": "Orion", "canonical_requests": 29, "observed_tokens": 2960000, "observed_actors": 6, "opted_in_actors": 6, "roster_members": 8, "sessions": 12, "provider_reported_cost_usd": 36.25, "estimated_metered_cost_usd": 27.60, "cost_known_visible_requests": 19, "cost_unknown_requests": 5, "cost_withheld_requests": 5,
        "daily": [{"day": d, "tokens": n, "status": s} for d,n,s in zip(DAYS,[210000,410000,450000,None,0,840000,1050000],STATUSES)]},
    "self": {"actor_id": "u01", "observed_tokens": 150000, "canonical_requests": 5, "sessions": 2, "estimated_metered_cost_usd": 18.0,
        "daily": [{"day": d, "tokens": n, "status": s} for d,n,s in zip(DAYS,[10000,20000,30000,None,0,40000,50000],SELF_STATUSES)]},
    "quality": {"duplicate_deliveries": 1, "corrections": 1, "late_records": 1, "missing_days": ["2026-11-14"], "partial_days": ["2026-11-13", "2026-11-17"], "advisory_state": "suppressed_incomplete_data"},
    "team_overlap": {"Orion_contributions_tokens": 2960000, "Lyra_contributions_tokens": 2240000, "sum_contributions_tokens": 5200000, "unique_tenant_tokens": 2960000},
    "baseline": None,
    "cost_class_note": "provider_reported is a proposed synthetic cost class, not the current Go CostSource=reported field.",
    "reviewer_fixture_note": "Detailed numerical overlap is an offline reviewer oracle only. The analyst HTML and SVG suppress subset/sum values.",
    "implementation": "Offline illustration only. Private team/admin views require a proposed tenant service and server-side authorization. Role preview grants no access."
}
C = {"bg":"#f3f4ef", "panel":"#ffffff", "ink":"#121714", "muted":"#59645c", "line":"#d7ded6", "green":"#235e43", "signal":"#b6f2cf", "amber":"#926a23", "pale":"#e8ede6"}
def n(v): return "Unknown" if v is None else f"{v:,}"
def text(x,y,t,size=14,color=None,weight=400,mono=False,anchor="start"):
    return f'<text x="{x}" y="{y}" font-family="{("monospace" if mono else "Arial, Helvetica, sans-serif")}" font-size="{size}" fill="{color or C["ink"]}" font-weight="{weight}" text-anchor="{anchor}">{escape(str(t))}</text>'
def rect(x,y,w,h,fill=None,stroke=None,rx=10):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{fill or C["panel"]}" stroke="{stroke or C["line"]}"/>'
def lines(x,y,content,maxchars=52,size=14,dy=21,color=None):
    ls = textwrap.wrap(content,maxchars)
    return "".join(text(x,y+i*dy,line,size,color) for i,line in enumerate(ls))
def pill(x,y,label,fill=None,w=None):
    width = w or max(64,len(label)*6.5+24)
    return rect(x,y,width,26,fill or C["pale"],fill or C["pale"],13)+text(x+12,y+18,label,11,C["green"],600)
def card(x,y,w,title,value,sub):
    return rect(x,y,w,108)+text(x+20,y+27,title,12,C["muted"],600)+text(x+20,y+66,value,32,C["ink"],600)+text(x+20,y+91,sub,11,C["muted"])
def chart_svg(values,w=690,h=195,compact=False):
    p = []; left=54; right=w-22; top=25; bottom=h-34
    maximum = max(v["tokens"] or 0 for v in values) or 1
    label = (lambda v: f"{v/1000000:.2f}M") if maximum >= 100000 else (lambda v: f"{v//1000}k")
    for f in (0,.5,1):
        yy=bottom-(bottom-top)*f
        p.append(f'<line x1="{left}" x2="{right}" y1="{yy}" y2="{yy}" stroke="{C["line"]}"/>')
        p.append(text(left-9,yy+4,label(round(maximum*f)),10,C["muted"],mono=True,anchor="end"))
    step=(right-left)/7
    for i,row in enumerate(values):
        xx=left+i*step+step*.24; bw=step*.52; v=row["tokens"]
        if v is None:
            p.append(f'<rect x="{xx}" y="{top}" width="{bw}" height="{bottom-top}" fill="url(#gap)" stroke="{C["line"]}" stroke-dasharray="3 4"/>')
            p.append(text(xx+bw/2,top+(bottom-top)/2+5,"?",17,C["muted"],mono=True,anchor="middle"))
        elif v==0:
            p.append(f'<line x1="{xx}" x2="{xx+bw}" y1="{bottom-2}" y2="{bottom-2}" stroke="{C["green"]}" stroke-width="3"/>')
            p.append(text(xx+bw/2,bottom-9,"0",11,C["green"],mono=True,anchor="middle"))
        else:
            hh=v/maximum*(bottom-top); yy=bottom-hh
            p.append(f'<rect x="{xx}" y="{yy}" width="{bw}" height="{hh}" rx="3" fill="{C["green"]}" opacity="{.7 if row["status"]=="partial" else 1}"/>')
            if row["status"]=="partial": p.append(f'<rect x="{xx}" y="{yy}" width="{bw}" height="{hh}" fill="url(#partial)"/>')
            p.append(text(xx+bw/2,yy-7,label(v),10,C["ink"],mono=True,anchor="middle"))
        p.append(text(xx+bw/2,bottom+21,row["day"][-2:]+" Nov",10,C["muted"],anchor="middle"))
    return "".join(p)
DEFS = '<defs><pattern id="gap" patternUnits="userSpaceOnUse" width="8" height="8"><path d="M0 8L8 0" stroke="#d7ded6" stroke-width="1"/></pattern><pattern id="partial" patternUnits="userSpaceOnUse" width="7" height="7"><path d="M0 7L7 0" stroke="#b6f2cf" stroke-width="1" opacity=".7"/></pattern></defs>'

def base(view,title,sub):
    p=[f'<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="980" viewBox="0 0 1440 980" role="img" aria-labelledby="title desc"><title id="title">{escape(title)} — proposed analytics wireframe</title><desc id="desc">Original synthetic illustration. No implemented or live product data. Fixed UTC window 11 through 17 November 2026.</desc>{DEFS}',
       rect(0,0,1440,980,C["bg"],C["bg"],0),
       rect(0,0,1440,42,C["ink"],C["ink"],0),
       text(32,27,DATA["label"],12,C["signal"],600,True),
       text(1408,27,"TRACK 05 / ANALYTICS STUDY",11,"#d3dcd3",400,True,"end"),
       text(32,88,"◌",32,C["green"],600),
       text(70,82,"TOKEN HORIZON",17,C["ink"],600),
       text(32,112,"ANALYTICS PROPOSAL",10,C["muted"],400,True),
       text(264,106,title,32,C["ink"],600),
       text(264,135,sub,14,C["muted"]),
       rect(32,156,204,752,"#edf0e9",C["line"],12),
       text(52,186,"ILLUSTRATED VIEWS",10,C["muted"],600,True)]
    for i,(key,label) in enumerate([("self","My usage"),("team","Team analysis"),("admin","Data quality")]):
        yy=208+i*55
        if key==view:p.append(rect(44,yy,180,44,C["green"],C["green"],7))
        p.append(text(60,yy+28,label,14,"#ffffff" if key==view else C["muted"],600 if key==view else 400))
    p+= [text(52,425,"ROLE PREVIEW",10,C["muted"],600,True),lines(52,450,{"self":"Self / u01","team":"Analyst / daily-detail grant","admin":"Tenant admin"}[view],22,14,21,C["ink"]),lines(52,510,"Illustration only. Navigation does not authenticate or grant access.",22,12,19,C["muted"]),lines(52,620,"Private team and admin analytics require a proposed tenant service.",23,12,19,C["muted"]),text(52,874,"No productivity ranks",11,C["green"],600),
       rect(264,158,1144,54,C["panel"],C["line"],8),text(284,181,"11–17 NOV 2026",12,C["ink"],600,True),text(284,200,"Start inclusive 11 Nov · End exclusive 18 Nov",10,C["muted"]),
       pill(664,171,"UTC · DAILY",w=112),
       text(799,183,"No comparison — baseline not supplied",12,C["muted"]),
       text(1388,183,"AS OF 18 NOV 06:00Z",10,C["muted"],400,True,"end")]
    return p

def svg_self():
    p=base("self","My usage","Your observed activity, with cost basis and publication gaps kept visible.")
    for x,title,val,sub in [(264,"OBSERVED TOKENS","150,000","5 reported positive days · one unknown day"),(556,"CANONICAL REQUESTS","5","Duplicates excluded"),(848,"ESTIMATED METERED COST","$18.00","USD · synthetic estimate, not an invoice"),(1140,"SESSIONS","2","Metadata only · no prompts")]:
        p.append(card(x,234,268,title,val,sub))
    p += [rect(264,366,740,298),text(286,395,"Usage across the selected window",18,C["ink"],600),text(286,418,"Exact daily tokens · UTC · one unknown date",12,C["muted"]),f'<g transform="translate(280,435)">{chart_svg(DATA["self"]["daily"],700,190)}</g>',
        rect(1024,366,384,298),text(1046,395,"Interpret this view",18,C["ink"],600),
        pill(1046,414,"INCOMPLETE COVERAGE",w=168),lines(1046,467,"14 Nov is unknown, not zero. All other dates are reported, including zero on 15 Nov.",45,14,23),
        lines(1046,565,"No percentage change is shown because a comparable baseline was not supplied.",43,13,21,C["muted"]),
        rect(264,688,740,221),text(286,718,"Inspect a day",18,C["ink"],600),text(286,744,"Selected: 14 Nov 2026 · UTC",12,C["muted"],400,True),
        text(286,791,"Unknown",36,C["ink"],600),pill(470,765,"NO READING",w=112),text(286,818,"Missing capture interval, not measured zero",12,C["muted"]),
        lines(286,852,"Full local session context remains on the device. This proposal uses synthetic metadata only.",83,12,19,C["muted"]),
        rect(1024,688,384,221),text(1046,718,"Useful next step",18,C["ink"],600),lines(1046,752,"Review the unknown capture interval on 14 Nov before comparing usage.",43,14,22),pill(1046,824,"Metric definitions",w=145),pill(1202,824,"JSON",w=70),
        text(264,944,"PROPOSAL · synthetic u01 · original wireframe · UTC only; arbitrary rebucketing needs event/hour coverage",11,C["muted"])]
    return "".join(p)+"</svg>"

def svg_team():
    p=base("team","Team analysis","Orion · restricted analyst view with a separate daily-detail grant.")
    for x,title,val,sub in [(264,"OBSERVED TOKENS","2.96M","Tenant-unique canonical usage"),(556,"PROVIDER-REPORTED COST","$36.25","USD · proposed synthetic class; not an invoice"),(848,"ESTIMATED METERED COST","$27.60","USD · separate basis; do not add to reported"),(1140,"CANONICAL REQUESTS","29","12 sessions · 6 observed actors")]:
        p.append(card(x,234,268,title,val,sub))
    p += [rect(264,366,740,298),text(286,395,"Usage across the selected window",18,C["ink"],600),text(286,418,"Restricted daily detail · broadly shared reports use at least 7-day bins",12,C["muted"]),f'<g transform="translate(280,435)">{chart_svg(DATA["team"]["daily"],700,190)}</g>',text(286,644,"Hatched bars: partial capture · Striped column: unknown",11,C["muted"]),
        rect(1024,366,384,298),text(1046,395,"Who is represented?",18,C["ink"],600),
        text(1046,447,"6 / 6",32,C["ink"],600),text(1161,447,"observed / opted in",12,C["muted"]),
        text(1046,481,"8",24,C["ink"],600),text(1081,481,"roster members",13,C["muted"]),
        lines(1046,524,"Participation is a population count. Complete capture is a separate question.",43,14,22),
        pill(1046,600,"2 partial days · 1 unknown",w=224),
        rect(264,688,553,221),text(286,718,"Known-visible cost coverage",18,C["ink"],600),text(286,759,"19 / 29",31,C["ink"],600),text(440,758,"canonical requests · 65.5%",12,C["muted"]),
        rect(286,779,507*19/29,16,C["green"],C["green"],0),rect(286+507*19/29,779,507*5/29,16,"#d9cba9","#d9cba9",0),rect(286+507*24/29,779,507*5/29,16,"#a7b2a8","#a7b2a8",0),
        text(286,820,"19 known-visible  ·  5 unknown  ·  5 withheld",12,C["muted"]),
        lines(286,854,"Known costs cover a subset. Withheld values remain private.",63,12,19,C["muted"]),
        rect(837,688,571,221),text(859,718,"Overlapping teams",18,C["ink"],600),text(859,754,"Orion contributions",13,C["muted"]),text(1386,754,"2.96M",15,C["ink"],600,True,"end"),
        text(859,784,"Lyra contributions",13,C["muted"]),text(1386,784,"Suppressed",14,C["muted"],600,False,"end"),text(859,814,"Contribution sum",13,C["muted"]),text(1386,814,"Suppressed",14,C["muted"],600,False,"end"),
        text(859,854,"Unique tenant usage",14,C["green"],600),text(1386,854,"2.96M",22,C["green"],600,True,"end"),
        text(859,882,"Hidden to prevent subtractive disclosure of a small complement.",11,C["muted"]),
        text(264,944,"PROPOSAL · synthetic tenant · restricted daily-detail grant illustrated; broadly shared cohorts require >=5 people and >=7-day bins",11,C["muted"])]
    return "".join(p)+"</svg>"

def svg_admin():
    p=base("admin","Data quality","Explain what the dashboard can support before generating comparisons or advisories.")
    for x,title,val,sub in [(264,"DUPLICATE DELIVERY","1","Suppressed from canonical request count"),(556,"CORRECTION","1","Applied as a replacement revision"),(848,"LATE RECORD","1","Assigned to event-time bucket"),(1140,"COST COVERAGE","19 / 29","65.5% known-visible requests")]:
        p.append(card(x,234,268,title,val,sub))
    p += [rect(264,366,1144,83,"#f6eddb","#d4bb86",9),text(286,397,"Advisory suppressed",19,C["ink"],600),text(286,426,"Incomplete capture: resolve the unknown day and partial buckets before emitting a comparable-period advisory.",14,C["muted"]),
        rect(264,473,740,249),text(286,504,"Capture coverage by day",18,C["ink"],600)]
    for i,(day,status) in enumerate(zip(DAYS,STATUSES)):
        x=286+i*99
        fill=C["green"] if status in ("reported","reported_zero") else "#d2bc89" if status=="partial" else C["pale"]
        p += [rect(x,530,82,74,fill,fill,7),text(x+41,557,day[-2:]+" NOV",11,"#ffffff" if fill==C["green"] else C["ink"],600,True,"middle"),text(x+41,583,{"reported":"Reported","partial":"Partial","unknown":"Unknown","reported_zero":"Zero"}[status],11,"#ffffff" if fill==C["green"] else C["ink"],600,False,"middle")]
    p += [lines(286,645,"13 and 17 Nov: partial. 14 Nov: unknown. 15 Nov: a reported zero remains distinct from a missing bucket.",82,13,22,C["muted"]),
        rect(1024,473,384,249),text(1046,504,"Controls that must hold",18,C["ink"],600),lines(1046,542,"Tenant scope on every read and export. Role checks enforced on the server. Redaction before aggregation.",43,14,24),lines(1046,644,"Role preview is an illustration. It does not implement authentication.",43,12,21,C["muted"]),
        rect(264,746,740,163),text(286,776,"Reconciliation",18,C["ink"],600),
        text(286,812,"Canonical requests",13,C["muted"]),text(976,812,"29",18,C["ink"],600,True,"end"),
        text(286,842,"Observed tokens",13,C["muted"]),text(976,842,"2,960,000",18,C["ink"],600,True,"end"),
        text(286,879,"Publication gaps must survive charting, comparison and export.",12,C["muted"]),
        rect(1024,746,384,163),text(1046,776,"Privacy and retention",18,C["ink"],600),lines(1046,811,"No prompts, credentials or raw local paths. Withheld costs stay unavailable. Retention policy needs a tenant contract.",44,13,22,C["muted"]),
        text(264,944,"PROPOSAL · synthetic admin evidence · policy checks and advisories shown here are unimplemented requirements",11,C["muted"])]
    return "".join(p)+"</svg>"

for filename,fn in [("self-analytics.svg",svg_self),("team-analytics.svg",svg_team),("admin-data-quality.svg",svg_admin)]:
    (OUT/"visuals"/filename).write_text(fn(),encoding="utf-8")

CSS = r"""
:root{--bg:#f3f4ef;--panel:#fff;--ink:#121714;--muted:#59645c;--line:#d7ded6;--green:#235e43;--signal:#b6f2cf;--amber:#926a23;--pale:#e8ede6}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:15px/1.5 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}button,select{font:inherit}button{cursor:pointer}button:disabled{cursor:not-allowed;opacity:.65}button:focus-visible,a:focus-visible,summary:focus-visible,select:focus-visible{outline:3px solid #146ac0;outline-offset:4px}a{color:var(--green)}
.proposal{background:var(--ink);color:var(--signal);padding:12px 28px;font:600 12px ui-monospace,monospace;display:flex;justify-content:space-between;gap:16px;flex-wrap:wrap}.brand{padding:26px 28px 14px;font-weight:650;letter-spacing:.06em;display:flex;justify-content:space-between;align-items:center;gap:16px}.brand small{font:11px ui-monospace,monospace;letter-spacing:.12em;color:var(--muted)}.layout{display:grid;grid-template-columns:210px minmax(0,1fr);gap:26px;padding:8px 28px 28px;max-width:1530px;margin:auto}.rail{background:#edf0e9;border:1px solid var(--line);border-radius:12px;padding:14px;align-self:start;position:sticky;top:16px}.rail p{font-size:12px;color:var(--muted)}.rail .small-title{font:10px ui-monospace,monospace;letter-spacing:.08em;margin:8px 0 14px}.nav-btn{display:block;width:100%;text-align:left;border:0;padding:13px 14px;background:transparent;border-radius:7px;margin:5px 0;color:var(--muted)}.nav-btn[aria-current=page]{background:var(--green);color:white;font-weight:650}.role{border-top:1px solid var(--line);margin-top:24px;padding-top:16px}.role label{font-size:11px;font-weight:600}.role select{display:block;width:100%;font-size:12px;padding:9px 5px;border:1px solid var(--line);background:white;border-radius:5px;margin:8px 0}.rail-foot{margin-top:32px;font-size:12px;font-weight:600;color:var(--green)}
h1{font-size:32px;font-weight:650;letter-spacing:-.035em;margin:0 0 4px}h2{font-size:18px;font-weight:650;margin:0 0 5px;letter-spacing:-.02em}h3{font-size:15px;margin:0 0 8px}.subtitle{color:var(--muted);margin:0 0 20px}.scope{background:white;border:1px solid var(--line);border-radius:8px;padding:12px 16px;display:flex;flex-wrap:wrap;gap:12px 28px;align-items:center;margin-bottom:20px}.scope strong{font:600 12px ui-monospace,monospace}.scope small{display:block;color:var(--muted);font-size:11px}.scope .asof{margin-left:auto}.tag{display:inline-block;background:var(--pale);color:var(--green);border-radius:20px;padding:5px 10px;font-size:11px;font-weight:650}.metrics{display:grid;grid-template-columns:repeat(4,minmax(0,1fr));gap:14px;margin:18px 0}.metric{background:white;border:1px solid var(--line);border-radius:9px;padding:16px 18px;min-height:124px}.metric .label{font-size:11px;font-weight:650;color:var(--muted);text-transform:uppercase;letter-spacing:.025em}.metric .value{font-size:32px;font-weight:650;letter-spacing:-.03em;margin:6px 0}.metric small{font-size:11px;color:var(--muted);display:block;line-height:1.5}.grid{display:grid;grid-template-columns:minmax(0,1.85fr) minmax(270px,1fr);gap:18px;margin:20px 0}.grid.equal{grid-template-columns:1fr 1fr}.panel{background:white;border:1px solid var(--line);border-radius:9px;padding:20px;min-width:0}.panel p{color:var(--muted);font-size:13px;margin:6px 0 16px}.chart{display:block;width:100%;height:auto;max-height:320px;margin:14px 0 4px}.legend{display:flex;flex-wrap:wrap;gap:12px;font-size:11px;color:var(--muted);margin-top:10px}.legend span:before{content:"";display:inline-block;width:11px;height:11px;background:var(--green);margin-right:5px;vertical-align:-1px}.legend .partial:before{background:repeating-linear-gradient(135deg,#235e43 0 2px,#b6f2cf 2px 3px)}.legend .unknown:before{background:repeating-linear-gradient(135deg,#fff 0 2px,#d7ded6 2px 3px)}.legend .zero:before{height:3px;vertical-align:3px}.actions{display:flex;gap:8px;flex-wrap:wrap;margin:16px 0}.btn{border:1px solid var(--line);background:var(--pale);color:var(--green);font-size:12px;font-weight:650;border-radius:6px;padding:9px 12px}.btn.primary{background:var(--green);color:white;border-color:var(--green)}.details{margin-top:18px;border-top:1px solid var(--line);padding-top:12px}summary{cursor:pointer;font-size:12px;font-weight:600;color:var(--green);padding:6px 0}.table-wrap{overflow:auto}table{width:100%;border-collapse:collapse;font-size:12px;margin:10px 0}th{text-align:left;color:var(--muted);font-weight:600;padding:9px 8px;border-bottom:1px solid var(--line)}td{padding:10px 8px;border-bottom:1px solid #e9ede7}td.num,th.num{text-align:right;font-family:ui-monospace,monospace;white-space:nowrap}.hint{background:#edf2ec;border-left:3px solid var(--green);padding:12px 14px;margin:16px 0;font-size:12px;color:var(--muted)}.population{font-size:35px;font-weight:650;letter-spacing:-.035em;margin:22px 0 4px}.population small{font-size:12px;color:var(--muted);letter-spacing:0;font-weight:400}.rule{border:0;border-top:1px solid var(--line);margin:20px 0}.basis{font-size:12px;color:var(--muted)}.coverage{display:flex;height:16px;margin:18px 0;border-radius:4px;overflow:hidden}.coverage .known{width:65.517241%;background:var(--green)}.coverage .unknown{width:17.241379%;background:#d9cba9}.coverage .withheld{width:17.241379%;background:#a7b2a8}.key-values{display:grid;grid-template-columns:1fr auto;gap:12px;font-size:13px}.key-values strong{font-family:ui-monospace,monospace;font-weight:600}.key-values .unique{color:var(--green);font-weight:650;border-top:1px solid var(--line);padding-top:13px}.warning{background:#f6eddb;border:1px solid #d4bb86;border-radius:8px;padding:16px 20px}.warning p{margin:4px 0 0;color:var(--muted);font-size:13px}.quality-days{display:grid;grid-template-columns:repeat(7,1fr);gap:8px;margin:20px 0}.quality-day{text-align:center;border-radius:7px;padding:16px 2px;font-size:11px;background:var(--green);color:white}.quality-day.partial{background:#d2bc89;color:var(--ink)}.quality-day.unknown{background:var(--pale);color:var(--ink)}.quality-day strong{display:block;font:600 11px ui-monospace,monospace;margin-bottom:9px}.quality-day span{font-size:11px}.checks{margin:8px 0;padding-left:20px}.checks li{margin:12px 0;font-size:13px;color:var(--muted)}footer{margin:24px 0 0;font:10px/1.8 ui-monospace,monospace;color:var(--muted);border-top:1px solid var(--line);padding-top:14px}.inspector{display:flex;gap:16px;align-items:center;margin:15px 0}.inspector label{font-size:12px;color:var(--muted)}.inspector select{background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:9px}.readout{font-size:32px;font-weight:650;margin:12px 0}.sr-only{position:absolute;left:-10000px;width:1px;height:1px;overflow:hidden}dialog{border:1px solid var(--line);border-radius:12px;max-width:760px;width:calc(100% - 40px);background:var(--bg);padding:24px;color:var(--ink);max-height:90vh;overflow:auto}dialog::backdrop{background:#12171488}.dialog-top{display:flex;align-items:center;justify-content:space-between;gap:15px}.dialog-top h2{margin:0}.dialog-note{font-size:12px;color:var(--muted)}.toast{position:fixed;right:24px;bottom:24px;background:var(--ink);color:var(--signal);padding:12px 16px;border-radius:8px;font-size:12px;box-shadow:0 6px 20px #12171422}.fixed-scope-note{font-size:11px;color:var(--muted);margin:-8px 0 18px}
@media(max-width:1080px){.layout{grid-template-columns:165px minmax(0,1fr);gap:16px;padding:8px 18px 18px}.metrics{grid-template-columns:repeat(2,1fr)}.grid{grid-template-columns:1fr}.rail{padding:10px}.grid.equal{grid-template-columns:1fr 1fr}}@media(max-width:720px){.layout{display:block;padding:8px 14px}.rail{position:static;padding:8px;margin-bottom:20px}.rail nav{display:flex;gap:6px;flex-wrap:wrap}.nav-btn{width:auto;flex:1;padding:10px 8px;font-size:12px;text-align:center}.rail .small-title,.role,.rail p,.rail-foot{display:none}.brand{padding:20px 16px 10px}.brand small{display:none}.proposal{padding:10px 16px;font-size:10px}.proposal span:last-child{display:none}h1{font-size:28px}.scope{gap:10px}.scope .asof{margin-left:0}.grid.equal{grid-template-columns:1fr}.metrics{gap:10px}.metric{padding:13px;min-height:130px}.metric .value{font-size:28px}.panel{padding:15px}.quality-days{gap:4px}.quality-day{padding:14px 1px}.quality-day span{font-size:9px}}
@media(prefers-reduced-motion:reduce){*{scroll-behavior:auto!important;animation:none!important;transition:none!important}}
"""
def htmlchart(which):
    vals=DATA[which]["daily"]
    return f'<svg class="chart" viewBox="0 0 690 215" role="img" aria-labelledby="{which}-chart-title {which}-chart-desc"><title id="{which}-chart-title">Daily observed tokens in UTC, 11 through 17 November 2026</title><desc id="{which}-chart-desc">14 November is unknown; 15 November is a reported zero. {"13 and 17 November are partial." if which == "team" else "All other dates are reported."} Exact values are in the following table.</desc>{DEFS}{chart_svg(vals,690,215)}</svg>'
def daily_table(which):
    status={"reported":"Reported","partial":"Partial","unknown":"Unknown — no reading","reported_zero":"Reported zero"}
    rows="".join(f'<tr><td>{r["day"]}</td><td class="num">{n(r["tokens"])}</td><td>{status[r["status"]]}</td></tr>' for r in DATA[which]["daily"])
    return '<div class="table-wrap"><table><caption class="sr-only">Exact synthetic daily values, UTC</caption><thead><tr><th scope="col">Date · UTC</th><th scope="col" class="num">Observed tokens</th><th scope="col">Data state</th></tr></thead><tbody>'+rows+'</tbody></table></div>'
def metric(label,value,sub): return f'<article class="metric"><div class="label">{label}</div><div class="value">{value}</div><small>{sub}</small></article>'
def chartpanel(which):
    return '<section class="panel"><h2>Usage across the selected window</h2><p>Exact daily tokens · UTC · gaps retain their meaning</p>'+htmlchart(which)+'<div class="legend"><span>Reported</span><span class="partial">Partial</span><span class="unknown">Unknown</span><span class="zero">Reported zero</span></div><details class="details" open><summary>View exact daily values</summary>'+daily_table(which)+'</details></section>'
self_html = '<div class="metrics">'+''.join([metric("Observed tokens","150,000","5 reported positive days · one unknown day"),metric("Canonical requests","5","Duplicates excluded"),metric("Estimated metered cost","$18.00","USD · synthetic estimate, not an invoice"),metric("Sessions","2","Metadata only · no prompts")])+'</div><div class="grid">'+chartpanel("self")+'''<aside class="panel"><h2>Interpret this view</h2><span class="tag">Incomplete coverage</span><p class="hint">14 Nov is unknown, not zero. All other dates are reported, including zero on 15 Nov.</p><h3>Inspect a day</h3><div class="inspector"><label for="day-select">Day · UTC</label><select id="day-select"></select></div><div id="day-reading" class="readout" aria-live="polite"></div><p id="day-status"></p><hr class="rule"><h3>Useful next step</h3><p>Review the unknown capture interval on 14 Nov before comparing usage. Full local session context remains on the device.</p><div class="actions"><button class="btn primary" data-definitions>Metric definitions</button><button class="btn" data-export>Export illustrative JSON</button></div><p class="basis">A percentage change is unavailable because a comparable baseline was not supplied.</p></aside></div>'''
team_html='<div class="metrics">'+''.join([metric("Observed tokens","2.96M","Tenant-unique canonical usage"),metric("Provider-reported cost","$36.25","USD · proposed synthetic class; not an invoice"),metric("Estimated metered cost","$27.60","USD · separate basis; do not add to reported"),metric("Canonical requests","29","12 sessions · 6 observed actors")])+'</div><div class="grid">'+chartpanel("team")+'''<aside class="panel"><h2>Who is represented?</h2><div class="population">6 / 6 <small>observed / opted in</small></div><p>8 roster members. Participation and complete capture are separate measurements.</p><span class="tag">2 partial days · 1 unknown</span><hr class="rule"><h3>Known-visible cost coverage</h3><div class="population">19 / 29 <small>requests · 65.5%</small></div><div class="coverage" role="img" aria-label="19 known-visible cost requests, 5 unknown, 5 withheld"><span class="known"></span><span class="unknown"></span><span class="withheld"></span></div><p>19 known-visible · 5 unknown · 5 withheld</p><p class="basis">Known costs cover a subset. Withheld values remain private. The two cost bases above remain separate.</p><div class="actions"><button class="btn primary" data-definitions>Metric definitions</button><button class="btn" data-export>Export illustrative JSON</button></div></aside></div><div class="grid equal"><section class="panel"><h2>Overlapping teams</h2><p>Contributions are membership-weighted. The subset and sum are suppressed to prevent subtraction from revealing a small complement.</p><div class="key-values"><span>Orion contributions</span><strong>2.96M</strong><span>Lyra contributions</span><strong>Suppressed</strong><span>Contribution sum</span><strong>Suppressed</strong><span class="unique">Unique tenant usage</span><strong class="unique">2.96M</strong></div></section><section class="panel"><h2>Scope before drilldown</h2><p>This restricted analyst illustration assumes a separate daily-detail grant. Broadly shared reports use cohorts of at least 5 people and at least 7-day bins. A proposed tenant service must enforce these scopes; no grant is implemented here.</p><button class="btn" disabled title="This fixture does not include per-provider request allocation.">Provider filtering requires dimension data</button><p class="hint">This proposal offers no member productivity scores. A request or token count describes observed consumption.</p></section></div>'''
admin_html='<div class="metrics">'+''.join([metric("Duplicate delivery","1","Suppressed from canonical request count"),metric("Correction","1","Applied as a replacement revision"),metric("Late record","1","Assigned to event-time bucket"),metric("Cost coverage","19 / 29","65.5% known-visible requests")])+'''</div><section class="warning" role="note"><h2>Advisory suppressed</h2><p>Incomplete capture: resolve the unknown day and partial buckets before emitting a comparable-period advisory.</p></section><div class="grid"><section class="panel"><h2>Capture coverage by day</h2><p>Zero and unknown remain different states.</p><div class="quality-days">'''+''.join(f'<div class="quality-day {s}"><strong>{d[-2:]} NOV</strong><span>{{"reported":"Reported","partial":"Partial","unknown":"Unknown","reported_zero":"Zero"}}[s]</span></div>' for d,s in []) # appended below for readable construction
admin_html += ''.join(f'<div class="quality-day {s}"><strong>{d[-2:]} NOV</strong><span>{ {"reported":"Reported","partial":"Partial","unknown":"Unknown","reported_zero":"Zero"}[s] }</span></div>' for d,s in zip(DAYS,STATUSES))
admin_html += '''</div><p>13 and 17 Nov: partial. 14 Nov: unknown. 15 Nov: reported zero.</p><details class="details" open><summary>Inspect capture states and canonical totals</summary>'''+daily_table("team")+'''</details></section><aside class="panel"><h2>Controls that must hold</h2><ul class="checks"><li>Tenant scope on every read and export.</li><li>Server-side role checks; role preview here grants no access.</li><li>Redaction before aggregation and export.</li><li>Fresh authorization when a downloadable report is retrieved.</li><li>No prompts, credentials or raw local paths.</li></ul><h3>Reconciliation</h3><div class="key-values"><span>Canonical requests</span><strong>29</strong><span>Observed tokens</span><strong>2,960,000</strong></div><div class="actions"><button class="btn primary" data-definitions>Metric definitions</button><button class="btn" data-export>Export illustrative JSON</button></div><p class="basis">Retention and advisory policies shown here are proposed requirements; no live alert is configured.</p></aside></div>'''

JS = r"""
const fixture = JSON.parse(document.getElementById('fixture').textContent);
const templates = {self:document.getElementById('self-template'),team:document.getElementById('team-template'),admin:document.getElementById('admin-template')};
const titles = {self:['My usage','Your observed activity, with cost basis and publication gaps kept visible.'],team:['Team analysis','Orion · restricted analyst view with a separate daily-detail grant.'],admin:['Data quality','Explain what the dashboard can support before comparisons or advisories.']};
let current='self', lastFocus=null;
const metricRows = [
 ['Observed tokens','Sum of canonical observed token values in the chosen interval','None; count, not a rate','Unknown days remain null; no imputation.'],
 ['Canonical requests','Count of unique request identities after deduplication and revision','None; distinct count','Corrections replace earlier revisions.'],
 ['Provider-reported cost','Sum of visible provider-reported cost amounts','None; USD amount','Proposed synthetic provider_reported class; not an invoice. Do not add metered estimates.'],
 ['Estimated metered cost','Sum of visible metered usage estimates','None; USD amount','A separate cost basis, not billed spend.'],
 ['Known-visible cost coverage (team)','19 requests with visible, known cost','29 canonical requests','19/29 = 65.5%; 5 unknown and 5 withheld.'],
 ['Observed participation (team)','6 actors with observed usage','6 opted-in actors','8 roster members; participation is not capture completeness.'],
 ['Unique tenant tokens (team/admin)','Sum once per canonical record inside authorized tenant','None','2.96M. Related subset and contribution-sum queries are suppressed to protect the small complement.'],
 ['Change vs previous period','Unavailable','Baseline not supplied','No percentage change or inferred savings.']
];
function render(view){
 current=view; document.getElementById('view').replaceChildren(templates[view].content.cloneNode(true));
 document.getElementById('heading').textContent=titles[view][0];document.getElementById('subtitle').textContent=titles[view][1];
 document.querySelectorAll('[data-view]').forEach(b=>b.setAttribute('aria-current',b.dataset.view===view?'page':'false'));
 document.getElementById('role-preview').value=view; document.getElementById('privacy-scope-note').textContent=view==='team'?' Restricted analyst illustration: separate daily-detail grant. Broadly shared reports require cohorts of at least 5 people and at least 7-day bins.':'';
 document.querySelectorAll('[data-definitions]').forEach(b=>b.addEventListener('click',()=>openDefinitions(b)));
 document.querySelectorAll('[data-export]').forEach(b=>b.addEventListener('click',exportData));
 const select=document.getElementById('day-select');
 if(select){fixture.self.daily.forEach(row=>{const o=document.createElement('option');o.value=row.day;o.textContent=row.day;select.append(o)});select.value='2026-11-14';select.addEventListener('change',readDay);readDay();}
 document.getElementById('view-announcement').textContent=titles[view][0]+' proposal selected. Synthetic data only.';
}
function readDay(){const r=fixture.self.daily.find(row=>row.day===document.getElementById('day-select').value);document.getElementById('day-reading').textContent=r.tokens===null?'Unknown':r.tokens.toLocaleString('en-US')+' tokens';document.getElementById('day-status').textContent=({'partial':'Partial capture; the reading may be revised.','unknown':'No reading. This is not measured zero.','reported_zero':'Explicitly reported zero usage.','reported':'Reported synthetic value.'})[r.status];}
function openDefinitions(button){lastFocus=button;const dialog=document.getElementById('dictionary');document.getElementById('dictionary-rows').innerHTML=metricRows.map(r=>'<tr>'+r.map((cell,i)=>'<'+(i===0?'th scope="row"':'td')+'>'+cell+'</'+(i===0?'th':'td')+'>').join('')+'</tr>').join('');dialog.showModal();document.getElementById('close-dictionary').focus();}
document.getElementById('close-dictionary').addEventListener('click',()=>document.getElementById('dictionary').close());
document.getElementById('dictionary').addEventListener('close',()=>lastFocus?.focus());
function exportData(){const selected=current==='admin'?'quality':current;const exportObject={label:fixture.label,exported_view:current,range:fixture.range,data:fixture[selected],baseline:null,role_scope:current==='self'?'illustrative_self_u01':current==='team'?'illustrative_restricted_analyst_daily_detail':'illustrative_tenant_admin',team_overlap:current==='team'?fixture.team_overlap:undefined,export_semantics:'Illustrative JSON only. Role scope and complementary suppression are applied to this synthetic output; this is not an authorized export service.',implementation:fixture.implementation};const blob=new Blob([JSON.stringify(exportObject,null,2)],{type:'application/json'});const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download='token-horizon-track5-'+current+'-synthetic.json';a.click();setTimeout(()=>URL.revokeObjectURL(url),500);const toast=document.getElementById('export-status');toast.hidden=false;toast.textContent='Illustrative role-scoped JSON prepared. Suppression applied; no network request.';setTimeout(()=>{toast.hidden=true},4000);}
document.querySelectorAll('[data-view]').forEach(b=>b.addEventListener('click',()=>render(b.dataset.view)));
document.getElementById('role-preview').addEventListener('change',e=>render(e.target.value));
render('self');
"""
HTML_DATA = json.loads(json.dumps(DATA))
HTML_DATA["team_overlap"] = {"Orion_contributions_tokens": 2960000, "Lyra_contributions_tokens": None, "sum_contributions_tokens": None, "unique_tenant_tokens": 2960000, "suppression": "complementary suppression protects a small complement"}
HTML_DATA["cost_class_note"] = "provider_reported is a proposed synthetic cost class, not the current Go CostSource=reported field."
HTML = '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light"><title>Token Horizon — Track 5 analytics proposals</title><style>'+CSS+'</style></head><body><div class="proposal"><span>'+DATA["label"]+'</span><span>TRACK 05 / ANALYTICS STUDY</span></div><header class="brand"><div><span style="font-size:27px;color:var(--green);vertical-align:-2px;margin-right:7px">◌</span>TOKEN HORIZON</div><small>ORIGINAL OFFLINE WIREFRAMES · 18 NOVEMBER 2026</small></header><div class="layout"><aside class="rail"><div class="small-title">ILLUSTRATED VIEWS</div><nav aria-label="Analytics proposal views"><button class="nav-btn" data-view="self">My usage</button><button class="nav-btn" data-view="team">Team analysis</button><button class="nav-btn" data-view="admin">Data quality</button></nav><div class="role"><label for="role-preview">Role preview · illustration only</label><select id="role-preview"><option value="self">Self / u01</option><option value="team">Analyst / daily-detail grant</option><option value="admin">Tenant admin</option></select><p>This changes the illustration. It does not authenticate or grant access.</p></div><p>Private team and admin analytics require a proposed tenant service.</p><div class="rail-foot">No productivity ranks</div></aside><main><h1 id="heading"></h1><p id="subtitle" class="subtitle"></p><section class="scope" aria-label="Fixed analytical scope"><div><strong>11–17 NOV 2026</strong><small>11 Nov inclusive · 18 Nov exclusive</small></div><span class="tag">UTC · DAILY</span><small>No comparison — baseline not supplied</small><div class="asof"><strong>AS OF 18 NOV 06:00Z</strong></div></section><p class="fixed-scope-note">UTC is fixed for this fixture. Rebucketed local-time analysis requires event or hour coverage; daily totals cannot establish it.<span id="privacy-scope-note"></span></p><div id="view"></div><div id="view-announcement" class="sr-only" aria-live="polite"></div><footer>PROPOSAL · SYNTHETIC DATA · NOT IMPLEMENTED<br>Operational views show consumption and measurement quality. Private tenant/RBAC, retention and alert services are proposed dependencies.<br>Interactive here: view navigation, illustrative role preview, daily inspection, metric definitions and illustrative role-scoped JSON download. No network, account data or external fonts.</footer></main></div><dialog id="dictionary" aria-labelledby="dictionary-title"><div class="dialog-top"><h2 id="dictionary-title">Proposed metric definitions</h2><button id="close-dictionary" class="btn" aria-label="Close metric definitions">Close</button></div><p class="dialog-note">PROPOSAL • SYNTHETIC DATA • NOT IMPLEMENTED. All metrics use the fixed UTC half-open interval and the displayed as-of timestamp.</p><div class="table-wrap"><table><thead><tr><th>Metric</th><th>Numerator / calculation</th><th>Denominator</th><th>Qualification</th></tr></thead><tbody id="dictionary-rows"></tbody></table></div></dialog><div id="export-status" class="toast" role="status" hidden></div><template id="self-template">'+self_html+'</template><template id="team-template">'+team_html+'</template><template id="admin-template">'+admin_html+'</template><script type="application/json" id="fixture">'+json.dumps(HTML_DATA,ensure_ascii=False)+'</script><script>'+JS+'</script></body></html>'
(OUT/"wireframes.html").write_text(HTML,encoding="utf-8")
(OUT/"wireframe-fixture.json").write_text(json.dumps(DATA,indent=2,ensure_ascii=False)+"\n",encoding="utf-8")
print(json.dumps({"html":str(OUT/"wireframes.html"),"svg_files":[str(p) for p in (OUT/"visuals").glob("*.svg")],"fixture_tokens":{"self":sum(r["tokens"] or 0 for r in DATA["self"]["daily"]),"team":sum(r["tokens"] or 0 for r in DATA["team"]["daily"])}}))

