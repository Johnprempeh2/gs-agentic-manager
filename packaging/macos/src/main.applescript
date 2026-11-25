-- GSAM for Mac. First open: sets everything up with a progress bar.
-- Every open after that: makes sure GSAM is running and opens its window.

property steps : {{"xcode", "Checking Apple's developer tools (a window may ask you to install them)"}, ¬
	{"node", "Installing Node.js"}, ¬
	{"rust", "Installing Rust (about 3 minutes)"}, ¬
	{"code", "Downloading GSAM"}, ¬
	{"deps", "Installing GSAM's components (about 5 minutes)"}, ¬
	{"tools", "Installing the Claude and ChatGPT sign-in apps"}, ¬
	{"service", "Setting GSAM to run in the background"}, ¬
	{"wait", "Starting GSAM for the first time (up to 10 minutes)"}}

on engine(stepName)
	set script_ to quoted form of (POSIX path of (path to resource "gsam.sh"))
	return do shell script "/bin/bash " & script_ & " " & stepName
end engine

on failed(stepTitle, errText)
	set choice to button returned of (display dialog "GSAM setup stopped at: " & stepTitle & return & return & errText & return & return & "You can open GSAM again to retry. Send the log to Greatstone if it keeps happening." buttons {"Show log", "Close"} default button "Close" with icon caution with title "GSAM")
	if choice is "Show log" then do shell script "open " & quoted form of (POSIX path of (path to home folder) & "Library/Application Support/GSAM/setup.log")
	error number -128
end failed

on signInClaude()
	set nodeBin to POSIX path of (path to home folder) & "Library/Application Support/GSAM/runtime/node/bin"
	tell application "Terminal"
		activate
		do script "export PATH=" & quoted form of nodeBin & ":$PATH; clear; echo 'Type /login and press Enter. Close this window when it says you are signed in.'; claude"
	end tell
end signInClaude

on runSetup()
	set progress total steps to (count of steps)
	set progress completed steps to 0
	set progress description to "Setting up GSAM"
	repeat with i from 1 to count of steps
		set {stepName, stepTitle} to item i of steps
		set progress additional description to stepTitle
		try
			engine(stepName)
		on error errText number errNum
			if errNum is -128 then error number -128
			failed(stepTitle, errText)
		end try
		set progress completed steps to i
	end repeat
end runSetup

on run
	activate -- bring our dialogs and progress window to the front
	set state to engine("status")
	if state is "new" then
		display dialog "Set up GSAM on this Mac?" & return & return & "This takes about 20 minutes and needs an internet connection. Your data stays on this Mac. Keep the Mac plugged in and awake." buttons {"Not now", "Set up"} default button "Set up" with icon note with title "GSAM"
		runSetup()
		set choice to button returned of (display dialog "GSAM is ready." & return & return & "It now runs in the background and starts with your Mac. Open this app any time to get back to it." & return & return & "Next: sign in to Claude with your own account, so your agents can work. A Terminal window opens; type /login, choose your Claude subscription, approve in the browser, then close the window." buttons {"Skip for now", "Sign in to Claude"} default button "Sign in to Claude" with icon note with title "GSAM")
		if choice is "Sign in to Claude" then signInClaude()
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
