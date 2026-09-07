Throwaway self-signed certificate for `localhost`, used only by `test.js` so the
fake push service can be reached over https (the app rejects plain http push
endpoints, as it should). It secures nothing real. Regenerate with:

    openssl req -x509 -newkey rsa:2048 -keyout localhost-key.pem \
      -out localhost-cert.pem -days 3650 -nodes -subj "/CN=localhost" \
      -addext "subjectAltName=DNS:localhost,IP:127.0.0.1"
