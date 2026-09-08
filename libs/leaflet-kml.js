/**
 * leaflet-kml.js — Lightweight KML parser for Leaflet.
 *
 * Parses <Placemark> elements with <Point> and <LineString> geometry.
 * Preserves <name>, <description>, <ExtendedData>, and <Style>/<LineStyle>/<IconStyle>.
 *
 * Usage:
 *   const layer = L.kml(kmlString);           // parse KML text
 *   const layer = await L.kmlFetch('path.kml'); // fetch + parse
 *   layer.addTo(map);
 *
 * Returns L.featureGroup with feature.properties attached to each layer.
 */
(function(L) {
  'use strict';

  if (!L) throw new Error('Leaflet must be loaded before leaflet-kml.js');

  // ── HELPERS ──────────────────────────────────────────────────────────────

  function _text(el, tag) {
    const n = el.getElementsByTagName(tag);
    return n.length ? (n[0].textContent || '').trim() : '';
  }

  function _attr(el, tag, attr) {
    const n = el.getElementsByTagName(tag);
    return n.length ? (n[0].getAttribute(attr) || '') : '';
  }

  function _parseCoordinates(str) {
    if (!str) return [];
    return str.trim().split(/\s+/).map(function(pair) {
      const parts = pair.split(',');
      const lng = parseFloat(parts[0]);
      const lat = parseFloat(parts[1]);
      return [lat, lng]; // Leaflet uses [lat, lng]
    }).filter(function(c) { return isFinite(c[0]) && isFinite(c[1]); });
  }

  function _parseExtendedData(placemark) {
    const data = {};
    const nodes = placemark.getElementsByTagName('Data');
    for (let i = 0; i < nodes.length; i++) {
      const name = nodes[i].getAttribute('name') || '';
      const valueEl = nodes[i].getElementsByTagName('value');
      const value = valueEl.length ? (valueEl[0].textContent || '').trim() : '';
      if (name) data[name] = value;
    }
    return data;
  }

  function _parseColor(str) {
    // KML color is aabbggrr (alpha, blue, green, red) → Leaflet #rrggbb
    if (!str || str.length < 6) return null;
    const bb = str.substring(0, 2);
    const gg = str.substring(2, 4);
    const rr = str.substring(4, 6);
    return '#' + rr + gg + bb;
  }

  function _parseLineStyle(placemark) {
    const lineStyles = placemark.getElementsByTagName('LineStyle');
    if (!lineStyles.length) return null;
    const color = _parseColor(_text(lineStyles[0], 'color'));
    const width = parseFloat(_text(lineStyles[0], 'width')) || null;
    const style = {};
    if (color) style.color = color;
    if (width) style.weight = width;
    return Object.keys(style).length ? style : null;
  }

  function _parseIconStyle(placemark) {
    const iconStyles = placemark.getElementsByTagName('IconStyle');
    if (!iconStyles.length) return null;
    const color = _parseColor(_text(iconStyles[0], 'color'));
    const scale = parseFloat(_text(iconStyles[0], 'scale')) || null;
    const href = _text(iconStyles[0], 'href');
    const style = {};
    if (color) style.color = color;
    if (scale) style.radius = Math.round(6 * scale);
    if (href) style.iconUrl = href;
    return Object.keys(style).length ? style : null;
  }

  // ── PARSE KML STRING → LAYER GROUP ──────────────────────────────────────

  function parseKml(kmlString) {
    const parser = new DOMParser();
    const doc = parser.parseFromString(kmlString, 'text/xml');

    const errorNode = doc.querySelector('parsererror');
    if (errorNode) {
      throw new Error('Invalid KML: ' + errorNode.textContent.substring(0, 100));
    }

    const group = L.featureGroup();
    const placemarks = doc.getElementsByTagName('Placemark');

    for (let i = 0; i < placemarks.length; i++) {
      const pm = placemarks[i];
      const name = _text(pm, 'name');
      const description = _text(pm, 'description');
      const extData = _parseExtendedData(pm);
      const lineStyle = _parseLineStyle(pm);
      const iconStyle = _parseIconStyle(pm);

      const id = extData.id || name || ('feature-' + i);

      // ── Point ──
      const pointEls = pm.getElementsByTagName('Point');
      if (pointEls.length) {
        const coords = _parseCoordinates(_text(pointEls[0], 'coordinates'));
        if (coords.length) {
          const ll = coords[0];
          const props = { id: id, name: name, description: description, type: 'point', properties: extData };

          let marker;
          if (iconStyle && iconStyle.iconUrl) {
            const iconOpts = {
              iconUrl: iconStyle.iconUrl,
              iconSize: [iconStyle.radius || 12, iconStyle.radius || 12]
            };
            marker = L.marker(ll, { icon: L.icon(iconOpts) });
          } else {
            marker = L.circleMarker(ll, {
              radius: 7,
              fillColor: iconStyle && iconStyle.color ? iconStyle.color : '#b0bec5',
              color: '#555',
              weight: 2,
              fillOpacity: 0.9
            });
          }

          marker.feature = props;
          marker.on('click', function() {
            group.fire('featureclick', { feature: props, layer: marker });
          });
          group.addLayer(marker);
        }
        continue;
      }

      // ── LineString ──
      const lineEls = pm.getElementsByTagName('LineString');
      if (lineEls.length) {
        const coords = _parseCoordinates(_text(lineEls[0], 'coordinates'));
        if (coords.length >= 2) {
          const style = Object.assign({
            color: '#3498db',
            weight: 4,
            opacity: 0.85
          }, lineStyle || {});

          const props = { id: id, name: name, description: description, type: 'line', properties: extData };
          const line = L.polyline(coords, style);
          line.feature = props;
          line.on('click', function() {
            group.fire('featureclick', { feature: props, layer: line });
          });
          group.addLayer(line);
        }
        continue;
      }
    }

    return group;
  }

  // ── FETCH + PARSE ───────────────────────────────────────────────────────

  L.kml = parseKml;

  L.kmlFetch = function(url) {
    return fetch(url).then(function(r) {
      if (!r.ok) throw new Error('KML fetch failed: HTTP ' + r.status);
      return r.text();
    }).then(function(text) {
      return parseKml(text);
    });
  };

})(L);
