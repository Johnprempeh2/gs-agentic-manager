-- GSAM for Mac. First open: asks for the licence key, then sets everything up with a progress bar,
-- then the owner makes their log-in in the GSAM window.
-- Every open after that: makes sure GSAM is running and opens its window.

property newSteps : {{"xcode", "Checking Apple's developer tools (a window may ask you to install them)"}, ¬
	{"node", "Installing Node.js"}, ¬
	{"activate", "Checking your licence key"}, ¬
	{"rust", "Installing Rust (about 3 minutes)"}, ¬
	{"code", "Downloading GSAM"}, ¬
	{"deps", "Installing GSAM's components (about 5 minutes)"}, ¬
	{"tools", "Installing the Claude and ChatGPT sign-in apps"}, ¬
	{"config", "Turning on log-ins and hourly backups"}, ¬
	{"service", "Setting GSAM to run in the background"}, ¬
	{"wait", "Starting GSAM for the first time (up to 10 minutes)"}}

-- An install from before licences: update, keep a backup, switch to log-ins. No data is removed.
property licenceSteps : {{"code", "Downloading the newest GSAM"}, ¬
	{"deps", "Installing GSAM's components (about 5 minutes)"}, ¬
	{"wait", "Making sure GSAM is running"}, ¬
	{"activate", "Checking your licence key"}, ¬
	{"config", "Backing up your data and turning on log-ins"}, ¬
	{"service", "Restarting GSAM"}, ¬
	{"wait", "Starting GSAM (up to 10 minutes)"}}

-- The licence key is passed along as a parameter, never kept in a property: an applet saves its properties.
on engine(stepName)
	return engineWith(stepName, "")
end engine

on engineWith(stepName, key_)
	set script_ to quoted form of (POSIX path of (path to resource "gsam.sh"))
	set env_ to ""
	if key_ is not "" then set env_ to "GSAM_LICENCE_KEY=" & quoted form of key_ & " "
	return do shell script env_ & "/bin/bash " & script_ & " " & stepName
end engineWith

on failed(stepTitle, errText)
	set choice to button returned of (display dialog "GSAM setup stopped at: " & stepTitle & return & return & errText & return & return & "You can open GSAM again to retry. Send the log to Greatstone if it keeps happening." buttons {"Show log", "Close"} default button "Close" with icon caution with title "GSAM")
	if choice is "Show log" then do shell script "open " & quoted form of (POSIX path of (path to home folder) & "Library/Application Support/GSAM/setup.log")
	error number -128
end failed

on askLicence(message)
	return text returned of (display dialog message & return & return & "Your licence key is in the email from Greatstone and on your GSAM page on the website. It starts with gsamlk_." default answer "" buttons {"Cancel", "Continue"} default button "Continue" with icon note with title "GSAM")
end askLicence

on runSteps(stepList, description_, key_)
	set progress total steps to (count of stepList)
	set progress completed steps to 0
	set progress description to description_
	repeat with i from 1 to count of stepList
		set {stepName, stepTitle} to item i of stepList
		set progress additional description to stepTitle
		repeat
			try
				engineWith(stepName, key_)
				exit repeat
			on error errText number errNum
				if errNum is -128 then error number -128
				-- A wrong licence key: ask again instead of stopping.
				if stepName is "activate" and errText contains "licence key" then
					set key_ to askLicence(errText & return & return & "Enter the licence key again.")
				else
					failed(stepTitle, errText)
				end if
			end try
		end repeat
		set progress completed steps to i
	end repeat
end runSteps

-- The owner makes their own log-in in the GSAM window (a one-time set-up link).
on ownerSetup()
	set progress description to "Your GSAM log-in"
	set progress additional description to "Opening the GSAM window"
	try
		set state to engine("owner")
	on error errText
		failed("Your GSAM log-in", errText)
	end try
	if state is "done" then return
	repeat
		set choice to button returned of (display dialog "Create your GSAM log-in in the window that just opened: your name, your email and a password of 12 or more characters." & return & return & "You are the owner. You can invite your team later from Access in GSAM. Click Done when you are signed in." buttons {"Open the window again", "Done"} default button "Done" with icon note with title "GSAM")
		if choice is "Open the window again" then
			engine("owner")
		else
			if engine("owner-done") is "yes" then exit repeat
			display dialog "GSAM has not seen your log-in yet. Finish creating it in the GSAM window, then click Done again." buttons {"OK"} default button "OK" with icon caution with title "GSAM"
		end if
	end repeat
end ownerSetup

-- Agents work through the person's own Claude or ChatGPT subscription.
on offerSignIns()
	set picked to choose from list {"Claude", "ChatGPT"} with title "GSAM" with prompt "GSAM is ready. It runs in the background and starts with your Mac." & return & return & "Next: sign in with your own AI subscription so your agents can work. Pick one or both. A Terminal window opens and guides you." OK button name "Sign in" cancel button name "Skip for now" with multiple selections allowed
	if picked is false then return
	set nodeBin to POSIX path of (path to home folder) & "Library/Application Support/GSAM/runtime/node/bin"
	set steps_ to ""
	if picked contains "ChatGPT" then set steps_ to steps_ & "echo 'ChatGPT: a browser window opens. Sign in and approve.'; codex login; "
	if picked contains "Claude" then set steps_ to steps_ & "echo 'Claude: type /login and press Enter, choose your Claude subscription and approve in the browser. Then type /exit.'; claude; "
	tell application "Terminal"
		activate
		do script "export PATH=" & quoted form of nodeBin & ":$PATH; clear; " & steps_ & "echo 'Done. You can close this window.'"
	end tell
end offerSignIns

on run
	activate -- bring our dialogs and progress window to the front
	set state to engine("status")
	if state is "new" then
		display dialog "Set up GSAM on this Mac?" & return & return & "This takes about 20 minutes and needs an internet connection and your licence key. Your data stays on this Mac. Keep the Mac plugged in and awake." buttons {"Not now", "Set up"} default button "Set up" with icon note with title "GSAM"
		runSteps(newSteps, "Setting up GSAM", askLicence("Enter your GSAM licence key."))
		ownerSetup()
		offerSignIns()
	else if state is "unlicensed" then
		display dialog "GSAM now needs a licence key, and everyone signs in with their own log-in." & return & return & "Your organisations, agents and work stay exactly as they are. GSAM makes a backup first. This takes about 10 minutes." buttons {"Not now", "Continue"} default button "Continue" with icon note with title "GSAM"
		runSteps(licenceSteps, "Updating GSAM", askLicence("Enter your GSAM licence key."))
		ownerSetup()
	else if state is "setup" then
		runSteps({{"wait", "Starting GSAM"}}, "Opening GSAM", "")
		ownerSetup()
		offerSignIns()
	else
		set newer to engine("newer")
		if newer is not "" then
			set choice to button returned of (display dialog "A new version of GSAM is ready (" & newer & ")." & return & return & "Updating takes a few minutes. Otherwise it installs itself tonight." buttons {"Later", "Update now"} default button "Update now" with icon note with title "GSAM")
			if choice is "Update now" then
				set progress description to "Updating GSAM"
				set progress additional description to "Installing " & newer
				try
					engine("update")
				on error errText
					failed("Updating GSAM", errText)
				end try
			end if
		end if
		set progress description to "Opening GSAM"
		set progress additional description to "Starting up"
		try
			engine("wait")
		on error errText
			failed("Starting GSAM", errText)
		end try
	end if
	engine("open")
end run
