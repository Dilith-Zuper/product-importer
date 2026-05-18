/**
 * Minimal HTML-entity decoder for QXO product strings.
 *
 * QXO catalog text fields embed raw HTML entities (`Timberline&reg;`,
 * `XT&trade; 25`, `90&deg;`). Plain text consumers (classifiers, family-tier
 * matchers, search) see these as literal `&reg;` substrings and fail to match.
 *
 * Use `decodeHtmlEntities()` whenever you need to compare or display these
 * strings as plain text. The result is also handy for `stripHtmlEntities()`
 * which just removes them — useful when the symbol isn't needed at all.
 */

const NAMED = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
  reg: '®', trade: '™', copy: '©',
  deg: '°', plusmn: '±', times: '×', divide: '÷',
  bull: '•', middot: '·', hellip: '…',
  ndash: '–', mdash: '—',
  lsquo: '‘', rsquo: '’', ldquo: '“', rdquo: '”',
  nbsp: ' ',
  frac12: '½', frac14: '¼', frac34: '¾',
  micro: 'µ',
};

function decodeHtmlEntities(s) {
  if (s == null) return s;
  return String(s)
    // Numeric: &#34; or &#x22;
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(parseInt(d, 10)))
    // Named
    .replace(/&([a-z]+);/gi, (m, name) => {
      const v = NAMED[name.toLowerCase()];
      return v == null ? m : v;
    });
}

function stripHtmlEntities(s) {
  if (s == null) return s;
  return String(s)
    .replace(/&#x[0-9a-f]+;/gi, '')
    .replace(/&#\d+;/g, '')
    .replace(/&[a-z]+;/gi, '');
}

module.exports = { decodeHtmlEntities, stripHtmlEntities };
