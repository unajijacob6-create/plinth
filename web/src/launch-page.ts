// Launch a fund: the form, with the wallet bar above it.
import { mountShell, BASE } from "./shell.ts";
import "./app.css";
import { mountWalletBar } from "./app.ts";
import { mountLaunch } from "./launch.ts";
import { restore, onAccount } from "./wallet.ts";

mountShell("launch", false);
const bar = mountWalletBar(document.getElementById("wallet-bar")!, async () => {});
onAccount(() => void bar.paint());
void restore().then(() => bar.paint());
// After a launch, open the new fund's card in the app.
mountLaunch((id) => location.assign(`${BASE}app/?fund=${encodeURIComponent(id)}`));
