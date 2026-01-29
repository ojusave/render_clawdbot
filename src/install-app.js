// Served at /install/app.js
// No fancy syntax: keep it maximally compatible.

(function () {
  var statusEl = document.getElementById('status');
  var authGroupEl = document.getElementById('authGroup');
  var authChoiceEl = document.getElementById('authChoice');
  var logEl = document.getElementById('log');
  var importForm = document.getElementById('importForm');
  var importFile = document.getElementById('importFile');

  function setStatus(s) {
    statusEl.textContent = s;
  }

  function renderAuth(groups) {
    authGroupEl.innerHTML = '';
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      var opt = document.createElement('option');
      opt.value = g.value;
      opt.textContent = g.label + (g.hint ? ' - ' + g.hint : '');
      authGroupEl.appendChild(opt);
    }

    authGroupEl.onchange = function () {
      var sel = null;
      for (var j = 0; j < groups.length; j++) {
        if (groups[j].value === authGroupEl.value) sel = groups[j];
      }
      authChoiceEl.innerHTML = '';
      var opts = (sel && sel.options) ? sel.options : [];
      for (var k = 0; k < opts.length; k++) {
        var o = opts[k];
        var opt2 = document.createElement('option');
        opt2.value = o.value;
        opt2.textContent = o.label + (o.hint ? ' - ' + o.hint : '');
        authChoiceEl.appendChild(opt2);
      }
    };

    authGroupEl.onchange();
  }

  function httpJson(url, opts) {
    opts = opts || {};
    opts.credentials = 'same-origin';
    return fetch(url, opts).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          throw new Error('HTTP ' + res.status + ': ' + (t || res.statusText));
        });
      }
      return res.json();
    });
  }

  function refreshStatus() {
    setStatus('Loading...');
    return httpJson('/install/api/status').then(function (j) {
      var ver = j.moltbotVersion ? (' | ' + j.moltbotVersion) : '';
      var note = j.moltbotMissing ? ' (moltbot binary missing in this environment)' : '';
      setStatus((j.configured ? 'Installed — Open Control UI above' : 'Not installed — run installer below') + ver + note);
      renderAuth(j.authGroups || []);
      if (j.warnings && j.warnings.length) {
        for (var i = 0; i < j.warnings.length; i++) {
          logEl.textContent += '\n' + j.warnings[i] + '\n';
        }
      }
    }).catch(function (e) {
      setStatus('Error: ' + String(e));
    });
  }

  document.getElementById('run').onclick = function () {
    var payload = {
      flow: document.getElementById('flow').value,
      authChoice: authChoiceEl.value,
      authSecret: document.getElementById('authSecret').value,
      telegramToken: document.getElementById('telegramToken').value,
      discordToken: document.getElementById('discordToken').value,
      slackBotToken: document.getElementById('slackBotToken').value,
      slackAppToken: document.getElementById('slackAppToken').value
    };

    logEl.textContent =
      'Running installer...\n' +
      'Selected auth method: ' + String(payload.authChoice || '(none)') + '\n' +
      'Flow: ' + String(payload.flow || '(none)') + '\n';

    fetch('/install/api/run', {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload)
    }).then(function (res) {
      return res.text();
    }).then(function (text) {
      var j;
      try { j = JSON.parse(text); } catch (_e) { j = { ok: false, output: text }; }
      logEl.textContent += (j.output || JSON.stringify(j, null, 2));
      return refreshStatus();
    }).catch(function (e) {
      logEl.textContent += '\nError: ' + String(e) + '\n';
    });
  };

  // Run doctor
  var doctorBtn = document.getElementById('doctorBtn');
  if (doctorBtn) {
    doctorBtn.onclick = function () {
      logEl.textContent += '\nRunning doctor...\n';
      fetch('/install/api/doctor', { method: 'POST', credentials: 'same-origin' })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          logEl.textContent += (j.output || JSON.stringify(j, null, 2)) + '\n';
        })
        .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
    };
  }

  // Channel help (show channels add --help in log)
  var channelHelpBtn = document.getElementById('channelHelpBtn');
  if (channelHelpBtn) {
    channelHelpBtn.onclick = function () {
      logEl.textContent += '\n--- moltbot channels add --help ---\n';
      httpJson('/install/api/status').then(function (j) {
        logEl.textContent += (j.channelsAddHelp || '(not available)') + '\n';
      }).catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
    };
  }

  // Pairing approve helper
  var pairingBtn = document.getElementById('pairingApprove');
  if (pairingBtn) {
    pairingBtn.onclick = function () {
      var channel = prompt('Enter channel (telegram or discord):');
      if (!channel) return;
      channel = channel.trim().toLowerCase();
      if (channel !== 'telegram' && channel !== 'discord') {
        alert('Channel must be "telegram" or "discord"');
        return;
      }
      var code = prompt('Enter pairing code (e.g. 3EY4PUYS):');
      if (!code) return;
      logEl.textContent += '\nApproving pairing for ' + channel + '...\n';
      fetch('/install/api/pairing/approve', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ channel: channel, code: code.trim() })
      }).then(function (r) { return r.text(); })
        .then(function (t) { logEl.textContent += t + '\n'; })
        .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
    };
  }

  document.getElementById('reset').onclick = function () {
    if (!confirm('Reset install? This deletes the config file so onboarding can run again.')) return;
    logEl.textContent = 'Resetting...\n';
    fetch('/install/api/reset', { method: 'POST', credentials: 'same-origin' })
      .then(function (res) { return res.text(); })
      .then(function (t) { logEl.textContent += t + '\n'; return refreshStatus(); })
      .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
  };

  if (importForm && importFile) {
    importForm.onsubmit = function (ev) {
      ev.preventDefault();
      if (!importFile.files || !importFile.files[0]) {
        alert('Choose a .tar.gz backup first.');
        return;
      }
      var fd = new FormData();
      fd.append('backup', importFile.files[0]);
      logEl.textContent += '\nUploading backup...\n';
      fetch('/install/api/import', {
        method: 'POST',
        credentials: 'same-origin',
        body: fd
      }).then(function (r) { return r.text(); })
        .then(function (t) {
          logEl.textContent += t + '\n';
          return refreshStatus();
        })
        .catch(function (e) { logEl.textContent += 'Error: ' + String(e) + '\n'; });
    };
  }

  refreshStatus();
})();

