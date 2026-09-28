var ws = new WebSocket(new URLSearchParams(location.search).get('url'));
ws.onopen = function () { ws.send('dispute DN-1002'); };
ws.onclose = function () { postMessage('closed'); };
