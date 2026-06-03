"""
ABC product → proposal_line_item classifier.

Ported from `lib/qxo-category-classifier.js`. Two-stage logic:

  1. CATEGORY_MAP — direct lookup on `product_category_norm`. ABC categories
     are already normalized to SRS canonical names (SHINGLES, HIP AND RIDGE,
     UNDERLAYMENT, ...) by `enrich-abc-category-norm.py`, so the map is much
     smaller than QXO's. Result shapes:
       - "<line item name>"   → direct assignment
       - {"sub": "<group>"}   → run sub-classifier
       - None                 → category is intentionally excluded

  2. SUB-CLASSIFIERS — when category is too coarse, decide by name keywords
     (family_name / brand_line_name / product_type_name concatenated). Patterns
     are copied verbatim from QXO sub-classifiers since they're catalog-agnostic.

Returns the proposal_line_item display_name (string) or None (excluded).
"""

import re

# ── Direct category lookups ────────────────────────────────────────────────
# Keys are SRS-canonical product_category_norm values (uppercase).
CATEGORY_MAP = {
    # Roofing primary materials
    "SHINGLES":              "Shingles",
    "HIP AND RIDGE":         "Hip & Ridge Cap",
    "STARTER":               "Starter Strip",

    # Underlayment + ice & water
    "UNDERLAYMENT":          {"sub": "underlayment"},
    "ICE AND WATER":         {"sub": "underlayment"},   # routes to ice-water variants

    # Flashing / edge / valley
    "DRIP EDGE":             "Drip Edge",
    "W-VALLEY":              "W-Valley",
    "GUTTER APRON":          "Gutter Apron",
    "OTHER FLASHING METAL":  {"sub": "flashing"},

    # Vents
    "VENTS":                 {"sub": "vent"},

    # Pipe flashing
    "PIPE FLASHING":         {"sub": "pipe"},

    # Skylights
    "SKYLIGHTS":             "Skylight",

    # Gutters
    "GUTTER/ALUMINUM/COIL":  {"sub": "gutter"},

    # Caulks / sealants / adhesives
    "CAULK":                 "Caulk / Sealant",

    # Fasteners / nails
    "OTHER FASTENERS":       {"sub": "nail"},
    "COIL NAILS":            "Coil Nails",
    "PLASTIC CAPS":          "Plastic Cap Nails",

    # Spray paint
    "SPRAY PAINT":           "Spray Paint",

    # Siding
    "SIDING":                "Siding",

    # Commercial (TPO/EPDM/modified bitumen/insulation)
    "COMMERCIAL":            "Commercial Membrane (TPO/EPDM)",

    # Decking — ABC's DECKING is composite/synthetic deck boards, NOT roof OSB
    "DECKING":               None,

    # Tools/safety — never proposal items
    "TOOLS/SAFETY":          None,

    # OTHER — catch-all for misc. Try heuristic on name; many will still drop to None.
    "OTHER":                 {"sub": "accessory"},
}


# ── Sub-classifiers (by product name keyword) ──────────────────────────────

def _sub_underlayment(name):
    n = name.lower()
    if re.search(r"\b(ice\s*&?\s*water|ice\s*and\s*water|iwgs|iws|water\s*shield)\b", n):
        return "Ice & Water — High Temp" if re.search(r"\bhigh.?temp|\bht\b", n) else "Ice & Water — Standard"
    if re.search(r"self.?adhered|peel.?and.?stick|high.?temp|\bht\b", n):
        return "Underlayment — Self-Adhered HT"
    if re.search(r"felt.*30|30.*felt|#30|\b30#", n):
        return "Underlayment — Felt 30#"
    if re.search(r"felt.*15|15.*felt|#15|\b15#", n):
        return "Underlayment — Felt 15#"
    if re.search(r"\bfelt\b", n):
        return "Underlayment — Felt 15#"
    return "Underlayment — Synthetic"


def _sub_flashing(name):
    n = name.lower()
    if re.search(r"chimney", n):
        return "Chimney Flashing Kit"
    if re.search(r"\bstep\b", n):
        return "Step Flashing"
    if re.search(r"headwall|counter.?flash|wall flash", n):
        return "Counter / Headwall Flashing"
    if re.search(r"valley", n):
        return "W-Valley"
    if re.search(r"drip.?edge|edge.?metal|gravel\s*guard|eave", n):
        return "Drip Edge"
    if re.search(r"gutter.?apron", n):
        return "Gutter Apron"
    if re.search(r"pipe\s*(boot|jack|flash|collar)|vent\s*pipe|roof\s*jack", n):
        return 'Pipe Boot 3"'
    if re.search(r"coil|flat\s*sheet|roll|sheet\s*metal|trim", n):
        return "Coil Stock / Sheet Metal"
    return "Step Flashing"  # default for OTHER FLASHING METAL when name uninformative


def _sub_vent(name):
    n = name.lower()
    if re.search(r"power|electric|solar.?attic|attic.?fan", n):
        return "Power Vent / Attic Fan"
    if re.search(r"ridge", n):
        return "Ridge Vent"
    if re.search(r"soffit", n):
        return "Soffit Vent"
    if re.search(r"dryer|exhaust|gooseneck|damper|vent\s*cap", n):
        return "Dryer / Exhaust Vent Cap"
    if re.search(r"\bdrain|scupper", n):
        return None  # commercial drain — not a residential proposal item
    return "Box Vent"


def _sub_pipe(name):
    n = name.lower()
    if re.search(r"\blead\b", n):
        return "Lead Flashing"
    if re.search(r"dryer|exhaust|gooseneck|vent\s*cap|damper", n):
        return "Dryer / Exhaust Vent Cap"
    m = re.search(r'\b([2346])"\s*(?:pipe|boot|jack|flash|collar)', n) or re.search(r"\b([2346])\s*inch", n)
    if m:
        return f'Pipe Boot {m.group(1)}"'
    return 'Pipe Boot 3"'


def _sub_gutter(name):
    n = name.lower()
    if re.search(r"\bdownspout\b", n):
        return "Downspouts"
    if re.search(r"end\s*cap", n):
        return "Gutter End Caps"
    if re.search(r"outside\s*(miter|corner)", n):
        return "Gutter Outside Corners"
    if re.search(r"inside\s*(miter|corner)", n):
        return "Gutter Inside Corners"
    if re.search(r"\belbow\b", n):
        return "Gutter Elbows"
    if re.search(r"strainer|cage|guard|bracket|hanger|screw|spike", n):
        return "Fasteners"
    if re.search(r"\bgutter\b", n):
        return "Gutter Sections"
    return "Coil Stock / Sheet Metal"


def _sub_nail(name):
    n = name.lower()
    if re.search(r"plastic\s*cap|cap\s*nail", n):
        return "Plastic Cap Nails"
    if re.search(r"coil.?nail", n):
        return "Coil Nails"
    if re.search(r"staple|brad|screw|anchor|bolt|clip", n):
        return "Fasteners"
    if re.search(r"\bnail\b", n):
        return "Coil Nails"
    return "Fasteners"


def _sub_accessory(name):
    """Catch-all heuristic on name. Returns None when nothing matches."""
    n = name.lower()
    # Gutter system
    if re.search(r"\bdownspout\b", n):                    return "Downspouts"
    if re.search(r"\belbow\b", n):                        return "Gutter Elbows"
    if re.search(r"end\s*cap", n):                        return "Gutter End Caps"
    if re.search(r"outside\s*(miter|corner)", n):         return "Gutter Outside Corners"
    if re.search(r"inside\s*(miter|corner)", n):          return "Gutter Inside Corners"
    if re.search(r"gutter\b", n):                         return "Gutter Sections"
    # Flashing / edge / valley
    if re.search(r"drip\s*edge|edge\s*metal|gravel\s*guard", n): return "Drip Edge"
    if re.search(r"gutter\s*apron", n):                   return "Gutter Apron"
    if re.search(r"\bw[- ]?valley\b|valley\s*metal|valley\s*flash", n): return "W-Valley"
    if re.search(r"step\s*flash", n):                     return "Step Flashing"
    if re.search(r"chimney", n):                          return "Chimney Flashing Kit"
    if re.search(r"headwall|counter\s*flash|wall\s*flash", n): return "Counter / Headwall Flashing"
    if re.search(r"termination\s*bar|trim\s*coil|j[- ]?channel|f[- ]?channel|coil\s*stock|flat\s*sheet|sheet\s*metal|gauge\s+\w*\s*(aluminum|steel|copper)", n):
        return "Coil Stock / Sheet Metal"
    # Underlayment & ice & water
    if re.search(r"ice\s*&?\s*water|water\s*shield|\biws\b|\biwgs\b", n):
        return "Ice & Water — High Temp" if re.search(r"high.?temp|\bht\b", n) else "Ice & Water — Standard"
    if re.search(r"underlayment|synthetic\s*felt|peel.?and.?stick", n):
        return _sub_underlayment(name)
    if re.search(r"\bfelt\b", n):
        return _sub_underlayment(name)
    # Vents
    if re.search(r"ridge\s*vent", n):                     return "Ridge Vent"
    if re.search(r"soffit\s*vent", n):                    return "Soffit Vent"
    if re.search(r"power\s*vent|attic\s*fan", n):         return "Power Vent / Attic Fan"
    if re.search(r"box\s*vent|static\s*vent", n):         return "Box Vent"
    if re.search(r"dryer|exhaust|gooseneck|damper|vent\s*cap", n): return "Dryer / Exhaust Vent Cap"
    # Pipe / lead / skylight
    if re.search(r"pipe\s*(boot|jack|flash|collar)|roof\s*jack", n): return _sub_pipe(name)
    if re.search(r"\blead\b.*(boot|jack|flash|collar|pipe)", n):     return "Lead Flashing"
    if re.search(r"skylight", n):                         return "Skylight"
    # Shingles
    if re.search(r"starter\s*(strip|shingle)", n):        return "Starter Strip"
    if re.search(r"hip\s*&?\s*ridge|ridge\s*cap", n):     return "Hip & Ridge Cap"
    if re.search(r"\bshingle", n):                        return "Shingles"
    if re.search(r"spray\s*paint|aerosol", n):            return "Spray Paint"
    # Caulks / sealants / adhesives
    if re.search(r"caulk|sealant|adhesive|mastic\s*(seal|cement)|asphalt\s*cement", n):
        return "Caulk / Sealant"
    # Insulation / commercial
    if re.search(r"foamular|insulation|polyiso|\beps\b|\bxps\b|coverboard|membrane|tpo|epdm|sbs|primer|coating|cold\s*process|hot\s*asphalt", n):
        return "Commercial Membrane (TPO/EPDM)"
    # Siding
    if re.search(r"siding|soffit\s*panel|fascia\s*panel", n):  return "Siding"
    # Fasteners / nails (broad — late so we don't grab too much)
    if re.search(r"plastic\s*cap.*nail|cap\s*nail", n):   return "Plastic Cap Nails"
    if re.search(r"coil\s*nail|coil\s*ring", n):          return "Coil Nails"
    if re.search(r"\bnail|staple|screw|anchor|rivet|fastener|spike|clip\b", n): return "Fasteners"
    return None


_SUB = {
    "underlayment": _sub_underlayment,
    "flashing":     _sub_flashing,
    "vent":         _sub_vent,
    "pipe":         _sub_pipe,
    "gutter":       _sub_gutter,
    "nail":         _sub_nail,
    "accessory":    _sub_accessory,
}


def classify_abc_product(category_norm, family_name, brand_line_name=None, product_type_name=None):
    """
    Main entry. Returns proposal_line_item display_name or None.

    Combines family_name + brand_line_name + product_type_name into a single
    haystack for the sub-classifiers since ABC distributes the descriptive
    keywords across all three fields (e.g. "Pipe Boot" might be in product_type_name
    while size is in family_name).
    """
    cat = (category_norm or "").strip().upper()
    haystack = " ".join(filter(None, [family_name, brand_line_name, product_type_name]))

    if not cat:
        return _sub_accessory(haystack) if haystack else None

    hit = CATEGORY_MAP.get(cat)
    if hit is None and cat not in CATEGORY_MAP:
        # Unknown category — try heuristic
        return _sub_accessory(haystack) if haystack else None
    if hit is None:
        return None  # explicit exclude
    if isinstance(hit, str):
        return hit
    if isinstance(hit, dict) and "sub" in hit:
        return _SUB[hit["sub"]](haystack)
    return None
