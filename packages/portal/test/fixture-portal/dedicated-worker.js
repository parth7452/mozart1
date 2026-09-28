fetch('/dispute-from-dedicated-worker', { method: 'POST', body: 'claim=DN-1001' }).catch(function () {}).then(function () { postMessage('done'); });
