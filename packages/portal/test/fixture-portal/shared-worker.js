self.onconnect = function (e) {
  var port = e.ports[0];
  fetch('/dispute-from-shared-worker', { method: 'POST', body: 'claim=DN-1001' }).catch(function () {}).then(function () { port.postMessage('done'); });
};
