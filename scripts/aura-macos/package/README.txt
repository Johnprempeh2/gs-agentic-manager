GSAM for macOS (company "Aura")

Install (Terminal, in this folder):
    bash install.sh

It puts everything in ~/GSAM-Aura, starts GSAM when you log in, adds a GSAM
icon to the Dock, then opens a page where you create your owner log-in and
press "Claim ownership". After that, open GSAM from the Dock.

Then link your own Claude and ChatGPT subscriptions in GSAM. Nothing is
linked by this installer, and John cannot work until Claude is linked.
    Claude:   Connectors > Anthropic > Connect > "Claude Subscription"
    ChatGPT:  Connectors > OpenAI > Connect > "OpenAI Subscription"
The task "Link your Claude and ChatGPT subscriptions" in GSAM says the same.

Commands:   ~/GSAM-Aura/app/bin/gsam-aura help
Uninstall:  bash uninstall.sh   (removes GSAM and all its data)
