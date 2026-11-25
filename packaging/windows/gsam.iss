; GSAM for Windows: the installer (Inno Setup 6). Built by packaging/windows/build.ps1.
;
; Per user, no administrator rights: the engine (src\gsam.ps1) and the licence
; activation (packaging\macos\src\mac-setup.mjs, shared with the Mac app) go to
; %LOCALAPPDATA%\GSAM; the wizard asks for the licence key, then the engine's
; setup step runs every install step in a console window that shows progress.
;
; Unsigned for now: Windows SmartScreen shows "Windows protected your PC"; the
; customer chooses More info, then Run anyway. To sign, define SignTool (see
; build.ps1: GSAM_SIGN_COMMAND, for example Azure Trusted Signing's signtool
; line) and the installer and its uninstaller are signed as they are built.

#ifndef AppVersion
  #define AppVersion "0.0.0"
#endif

[Setup]
AppId={{6F3C2B1E-6C55-4B8E-9C2D-0A6B5E1D7F42}
AppName=GSAM
AppVersion={#AppVersion}
AppPublisher=Greatstone
AppPublisherURL=https://greatstoneint.com
DefaultDirName={localappdata}\GSAM
DisableDirPage=yes
DisableProgramGroupPage=yes
DisableReadyPage=yes
PrivilegesRequired=lowest
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
MinVersion=10.0.17763
OutputDir=dist
OutputBaseFilename=GSAM-Setup
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
UninstallDisplayName=GSAM
UninstallDisplayIcon={sys}\WindowsPowerShell\v1.0\powershell.exe
#ifdef SignTool
SignTool=gsamsign
SignedUninstaller=yes
#endif

[Files]
Source: "src\gsam.ps1"; DestDir: "{app}"; Flags: ignoreversion
Source: "..\macos\src\mac-setup.mjs"; DestDir: "{app}"; Flags: ignoreversion
Source: "build\hub-url"; DestDir: "{app}"; Flags: ignoreversion

[Icons]
Name: "{userprograms}\GSAM"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\gsam.ps1"" open"; \
  Comment: "Open GSAM"
Name: "{userprograms}\GSAM log"; Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File ""{app}\gsam.ps1"" log"

[UninstallRun]
Filename: "{sys}\WindowsPowerShell\v1.0\powershell.exe"; \
  Parameters: "-NoProfile -NonInteractive -ExecutionPolicy Bypass -File ""{app}\gsam.ps1"" uninstall"; \
  Flags: runhidden waituntilterminated; RunOnceId: "GsamUninstall"

[Code]
var
  KeyPage: TInputQueryWizardPage;

function SetEnvironmentVariable(lpName, lpValue: String): BOOL;
  external 'SetEnvironmentVariableW@kernel32.dll stdcall';

procedure InitializeWizard;
begin
  KeyPage := CreateInputQueryPage(wpWelcome, 'Your licence key',
    'GSAM needs the licence key from your email or the Greatstone website.',
    'Paste the key below. It starts with gsamlk_.');
  KeyPage.Add('Licence key:', False);
  KeyPage.Values[0] := GetEnv('GSAM_LICENCE_KEY');
end;

function NextButtonClick(CurPageID: Integer): Boolean;
begin
  Result := True;
  if (CurPageID = KeyPage.ID) and (Pos('gsamlk_', Trim(KeyPage.Values[0])) <> 1) then
  begin
    MsgBox('That is not a GSAM licence key. It starts with gsamlk_. Copy it again from the email or the website.', mbError, MB_OK);
    Result := False;
  end;
end;

// The key reaches the engine through this process's environment, never a
// file or a command line other users could see.
procedure CurStepChanged(CurStep: TSetupStep);
var
  ResultCode: Integer;
begin
  if CurStep = ssPostInstall then
  begin
    SetEnvironmentVariable('GSAM_LICENCE_KEY', Trim(KeyPage.Values[0]));
    WizardForm.StatusLabel.Caption := 'Setting up GSAM. A window shows each step; it takes about 15 minutes.';
    Exec(ExpandConstant('{sys}\WindowsPowerShell\v1.0\powershell.exe'),
      '-NoProfile -ExecutionPolicy Bypass -File "' + ExpandConstant('{app}\gsam.ps1') + '" setup',
      '', SW_SHOW, ewWaitUntilTerminated, ResultCode);
    SetEnvironmentVariable('GSAM_LICENCE_KEY', '');
    if (ResultCode <> 0) and not WizardSilent then
      MsgBox('GSAM is not set up yet. Open the installer again to carry on from where it stopped, ' +
        'or send ' + ExpandConstant('{app}\setup.log') + ' to Greatstone.', mbError, MB_OK);
  end;
end;
