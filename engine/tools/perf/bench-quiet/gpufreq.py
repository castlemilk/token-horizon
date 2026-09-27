#!/usr/bin/env python3
"""gpufreq.py [secs=2] [--loop N] — GPU active-residency-weighted frequency via IOReport (no root).
Reads the "GPU Stats" / "GPU Performance States" channel ("GPUPH"), diffs two samples,
prints {"t", "active_pct", "mhz_weighted", "residency"}. P-state MHz come from the
pmgr "voltage-states9" table in ioreg (AppleARMIODevice pmgr), when readable."""
import ctypes, ctypes.util, json, re, subprocess, sys, time

cf = ctypes.CDLL(ctypes.util.find_library("CoreFoundation"))
ior = ctypes.CDLL("/usr/lib/libIOReport.dylib") if False else ctypes.CDLL(ctypes.util.find_library("IOReport") or "libIOReport.dylib")
vp = ctypes.c_void_p
cf.CFStringCreateWithCString.restype = vp; cf.CFStringCreateWithCString.argtypes = [vp, ctypes.c_char_p, ctypes.c_uint32]
cf.CFDictionaryGetValue.restype = vp; cf.CFDictionaryGetValue.argtypes = [vp, vp]
cf.CFArrayGetCount.restype = ctypes.c_long; cf.CFArrayGetCount.argtypes = [vp]
cf.CFArrayGetValueAtIndex.restype = vp; cf.CFArrayGetValueAtIndex.argtypes = [vp, ctypes.c_long]
cf.CFStringGetCString.restype = ctypes.c_bool; cf.CFStringGetCString.argtypes = [vp, ctypes.c_char_p, ctypes.c_long, ctypes.c_uint32]
cf.CFRelease.argtypes = [vp]
ior.IOReportCopyChannelsInGroup.restype = vp; ior.IOReportCopyChannelsInGroup.argtypes = [vp, vp, ctypes.c_uint64, ctypes.c_uint64, ctypes.c_uint64]
ior.IOReportCreateSubscription.restype = vp; ior.IOReportCreateSubscription.argtypes = [vp, vp, ctypes.POINTER(vp), ctypes.c_uint64, vp]
ior.IOReportCreateSamples.restype = vp; ior.IOReportCreateSamples.argtypes = [vp, vp, vp]
ior.IOReportCreateSamplesDelta.restype = vp; ior.IOReportCreateSamplesDelta.argtypes = [vp, vp, vp]
ior.IOReportChannelGetSubGroup.restype = vp; ior.IOReportChannelGetSubGroup.argtypes = [vp]
ior.IOReportChannelGetChannelName.restype = vp; ior.IOReportChannelGetChannelName.argtypes = [vp]
ior.IOReportStateGetCount.restype = ctypes.c_int32; ior.IOReportStateGetCount.argtypes = [vp]
ior.IOReportStateGetNameForIndex.restype = vp; ior.IOReportStateGetNameForIndex.argtypes = [vp, ctypes.c_int32]
ior.IOReportStateGetResidency.restype = ctypes.c_int64; ior.IOReportStateGetResidency.argtypes = [vp, ctypes.c_int32]

def cfs(s):
    return cf.CFStringCreateWithCString(None, s.encode(), 0x08000100)

def pystr(ref):
    if not ref:
        return ""
    buf = ctypes.create_string_buffer(256)
    cf.CFStringGetCString(ref, buf, 256, 0x08000100)
    return buf.value.decode()

def gpu_mhz_table():
    try:
        t = subprocess.run(["ioreg", "-rd1", "-c", "AppleARMIODevice", "-n", "pmgr"], capture_output=True, text=True).stdout
        m = re.search(r'"voltage-states9-sram" = <([0-9a-f]+)>', t) or re.search(r'"voltage-states9" = <([0-9a-f]+)>', t)
        if not m:
            return None
        b = bytes.fromhex(m.group(1))
        fr = [int.from_bytes(b[i:i + 4], "little") for i in range(0, len(b), 8)]
        return [f / 1e6 if f > 1e5 else f for f in fr if f]
    except Exception:
        return None

grp = cfs("GPU Stats")
chans = ior.IOReportCopyChannelsInGroup(grp, None, 0, 0, 0)
sub_dict = vp()
sub = ior.IOReportCreateSubscription(None, chans, ctypes.byref(sub_dict), 0, None)
KEY = cfs("IOReportChannels")

def sample():
    return ior.IOReportCreateSamples(sub, sub_dict, None)

def read(delta):
    arr = cf.CFDictionaryGetValue(delta, KEY)
    out = {}
    for i in range(cf.CFArrayGetCount(arr)):
        ch = cf.CFArrayGetValueAtIndex(arr, i)
        sg = pystr(ior.IOReportChannelGetSubGroup(ch)); nm = pystr(ior.IOReportChannelGetChannelName(ch))
        if sg == "GPU Performance States" and nm == "GPUPH":
            n = ior.IOReportStateGetCount(ch)
            out = {pystr(ior.IOReportStateGetNameForIndex(ch, k)): ior.IOReportStateGetResidency(ch, k) for k in range(n)}
    return out

def once(secs):
    a = sample(); t0 = time.time(); time.sleep(secs); b = sample()
    d = ior.IOReportCreateSamplesDelta(a, b, None)
    res = read(d)
    cf.CFRelease(a); cf.CFRelease(b); cf.CFRelease(d)
    tot = sum(res.values()) or 1
    idle = sum(v for k, v in res.items() if k.upper() in ("OFF", "IDLE", "DOWN"))
    act = {k: v for k, v in res.items() if k.upper() not in ("OFF", "IDLE", "DOWN")}
    tab = gpu_mhz_table()
    mhz = None
    if tab and act:
        keys = list(act.keys())
        w = 0.0; s = 0
        for j, k in enumerate(keys):
            if j < len(tab):
                w += tab[j] * act[k]; s += act[k]
        mhz = w / s if s else None
    return {"t": time.strftime("%H:%M:%S", time.localtime(t0)), "active_pct": round(100 * (tot - idle) / tot, 1),
            "mhz_weighted": round(mhz, 0) if mhz else None,
            "residency_pct": {k: round(100 * v / tot, 1) for k, v in res.items() if v}}

if __name__ == "__main__":
    secs = float(sys.argv[1]) if len(sys.argv) > 1 and not sys.argv[1].startswith("-") else 2.0
    n = int(sys.argv[sys.argv.index("--loop") + 1]) if "--loop" in sys.argv else 1
    for _ in range(n):
        print(json.dumps(once(secs)), flush=True)
