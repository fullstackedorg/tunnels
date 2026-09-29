import tunnel from "fullstacked/tunnel";

// 1. Establish tunneled socket to external HTTP service using the tunnel token
const host = await tunnel.register({
  host: "localhost:3000",
  authorization: "<http-tunnel-token>"
});

// 2. Send HTTP request to the assigned tunneled host and internal service port
const response = await fetch(`http://${host}:8080/health`, {
  method: "GET",
  headers: {
    "Content-Type": "application/json"
  }
});

const data = await response.json();
console.log(`Response from tunneled HTTP destination: ${JSON.stringify(data)}`);

