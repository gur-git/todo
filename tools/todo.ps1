<#
.SYNOPSIS
  Read and write the todo list from the PC, over the same GitHub Contents API
  the phone app uses.

.DESCRIPTION
  The token is read from a DPAPI-encrypted file, so it is readable only by this
  Windows account on this machine. Writes are compare-and-swap on the file's
  sha: if the phone changed something first, the write is retried against the
  fresh copy rather than clobbering it.

.EXAMPLE
  .\todo.ps1 list
  .\todo.ps1 list -Topic lab -State flagged
  .\todo.ps1 add -Text "review the Session 8 lab prep" -Topic degree -Flag
  .\todo.ps1 flag -Id t_ab12cd34ef
  .\todo.ps1 done -Id t_ab12cd34ef
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory, Position = 0)]
  [ValidateSet('list', 'add', 'done', 'flag', 'wait', 'normal', 'note', 'topics')]
  [string]$Command,

  [string]$Text,
  [string]$Topic,
  [string]$Id,
  [string]$Note,
  [ValidateSet('flagged', 'waiting', 'normal')][string]$State,
  [switch]$Flag,
  [switch]$Waiting,
  # Emit objects instead of the coloured human view, so callers (the hook,
  # /session-end, burn.ps1) can pipe and filter rather than scrape.
  [switch]$Json
)

$ErrorActionPreference = 'Stop'

$script:Owner = 'gur-git'
$script:Repo = 'todo-data'
$script:Path = 'tasks.json'
$script:TokenFile = Join-Path $env:USERPROFILE '.claude\todo-token.xml'

function Get-Token {
  if (-not (Test-Path $script:TokenFile)) {
    throw "No token at $($script:TokenFile). Create one (Contents: read and write on $($script:Owner)/$($script:Repo)) and store it with: ConvertTo-SecureString '<pat>' -AsPlainText -Force | Export-CliXml '$($script:TokenFile)'"
  }
  $sec = Import-CliXml $script:TokenFile
  [System.Net.NetworkCredential]::new('', $sec).Password
}

function Get-Headers {
  @{
    Authorization          = "Bearer $(Get-Token)"
    Accept                 = 'application/vnd.github+json'
    'X-GitHub-Api-Version' = '2022-11-28'
    'Cache-Control'        = 'no-cache'
  }
}

$script:MarkerFile = Join-Path $env:USERPROFILE '.claude\todo-lastwrite.json'

function Set-LastWrite {
  param([string]$Sha)
  @{ sha = $Sha; at = (Get-Date).ToUniversalTime().ToString('o') } |
    ConvertTo-Json | Set-Content -Path $script:MarkerFile -Encoding utf8
}

function Get-LastWrite {
  if (-not (Test-Path $script:MarkerFile)) { return $null }
  try { Get-Content $script:MarkerFile -Raw | ConvertFrom-Json } catch { $null }
}

function Get-Board {
  # GitHub's contents API can serve the pre-write copy for a second or two after
  # a write. Writes are safe regardless (a stale read carries a stale sha, so the
  # conditional PUT is rejected), but a `list` that shows a task you just
  # finished is not trustworthy. So: only when we wrote very recently, wait for
  # the server to catch up to our own sha. A write from the phone changes the
  # sha legitimately, hence the short window rather than a blanket retry.
  $marker = Get-LastWrite
  $deadline = $null
  if ($marker -and $marker.sha) {
    $age = (Get-Date).ToUniversalTime() - ([datetime]$marker.at).ToUniversalTime()
    if ($age.TotalSeconds -lt 15) { $deadline = (Get-Date).AddSeconds(8) }
  }

  $bust = [Guid]::NewGuid().ToString('N')
  $uri = "https://api.github.com/repos/$($script:Owner)/$($script:Repo)/contents/$($script:Path)?nocache=$bust"

  while ($true) {
    $res = Invoke-RestMethod -Uri $uri -Headers (Get-Headers)
    if (-not $deadline -or $res.sha -eq $marker.sha -or (Get-Date) -gt $deadline) { break }
    Start-Sleep -Milliseconds 400
    $bust = [Guid]::NewGuid().ToString('N')
    $uri = "https://api.github.com/repos/$($script:Owner)/$($script:Repo)/contents/$($script:Path)?nocache=$bust"
  }

  $json = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($res.content))
  [pscustomobject]@{
    State = $json | ConvertFrom-Json
    Sha   = $res.sha
  }
}

# Emits exactly what JSON.stringify(value, null, 2) produces in the app.
# ConvertTo-Json indents differently and escapes every non-ASCII character, so
# alternating writers would rewrite the whole file each time and bury the real
# change in whitespace noise.
function ConvertTo-AppJson {
  param($Value, [int]$Indent = 0)

  $pad = ' ' * $Indent
  $padIn = ' ' * ($Indent + 2)

  if ($null -eq $Value) { return 'null' }
  if ($Value -is [bool]) { return $(if ($Value) { 'true' } else { 'false' }) }
  if ($Value -is [int] -or $Value -is [long] -or $Value -is [double] -or $Value -is [decimal]) {
    return [string]$Value
  }
  if ($Value -is [string]) { return ConvertTo-JsonString $Value }

  if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [string]) {
    $items = @($Value)
    if ($items.Count -eq 0) { return '[]' }
    $parts = $items | ForEach-Object { $padIn + (ConvertTo-AppJson -Value $_ -Indent ($Indent + 2)) }
    return "[`n" + ($parts -join ",`n") + "`n$pad]"
  }

  $props = @($Value.PSObject.Properties)
  if ($props.Count -eq 0) { return '{}' }
  $parts = $props | ForEach-Object {
    $padIn + (ConvertTo-JsonString $_.Name) + ': ' + (ConvertTo-AppJson -Value $_.Value -Indent ($Indent + 2))
  }
  return "{`n" + ($parts -join ",`n") + "`n$pad}"
}

function ConvertTo-JsonString {
  param([string]$Text)
  $sb = [Text.StringBuilder]::new('"')
  foreach ($ch in $Text.ToCharArray()) {
    switch ($ch) {
      '"' { [void]$sb.Append('\"'); continue }
      '\' { [void]$sb.Append('\\'); continue }
      "`b" { [void]$sb.Append('\b'); continue }
      "`f" { [void]$sb.Append('\f'); continue }
      "`n" { [void]$sb.Append('\n'); continue }
      "`r" { [void]$sb.Append('\r'); continue }
      "`t" { [void]$sb.Append('\t'); continue }
      default {
        if ([int]$ch -lt 0x20) { [void]$sb.AppendFormat('\u{0:x4}', [int]$ch) }
        else { [void]$sb.Append($ch) }   # non-ASCII stays literal, as in JS
      }
    }
  }
  [void]$sb.Append('"')
  $sb.ToString()
}

function Save-Board {
  param($State, $Sha, [string]$Message)
  $ordered = [pscustomobject]@{ version = 1; topics = $State.topics; tasks = $State.tasks }
  $json = (ConvertTo-AppJson -Value $ordered) + "`n"
  $body = @{
    message = $Message
    content = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($json))
    branch  = 'main'
    sha     = $Sha
  } | ConvertTo-Json
  $uri = "https://api.github.com/repos/$($script:Owner)/$($script:Repo)/contents/$($script:Path)"
  $res = Invoke-RestMethod -Uri $uri -Method Put -Headers (Get-Headers) -Body $body -ContentType 'application/json'
  Set-LastWrite -Sha $res.content.sha
}

# Applies $Mutate to the board and writes it back; on a conflicting write the
# board is re-read and the change re-applied, so a simultaneous phone edit is
# merged rather than lost.
function Update-Board {
  param([scriptblock]$Mutate, [string]$Message)
  for ($attempt = 0; $attempt -lt 3; $attempt++) {
    $board = Get-Board
    $changed = & $Mutate $board.State
    if (-not $changed) { return $false }
    try {
      Save-Board -State $board.State -Sha $board.Sha -Message $Message
      return $true
    }
    catch {
      $code = $null
      if ($_.Exception.Response) { $code = $_.Exception.Response.StatusCode.value__ }
      if ($code -eq 409 -or $code -eq 422) { Start-Sleep -Milliseconds 300; continue }
      throw
    }
  }
  throw 'Gave up after repeated write conflicts.'
}

function New-TaskId {
  $chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  't_' + (-join (1..10 | ForEach-Object { $chars[(Get-Random -Maximum $chars.Length)] }))
}

function Find-Task {
  param($State, [string]$TaskId)
  $hit = $State.tasks | Where-Object { $_.id -eq $TaskId }
  if (-not $hit) { throw "No task with id '$TaskId'." }
  $hit
}

function Show-Board {
  param($State, [string]$FilterTopic, [string]$FilterState)
  $glyph = @{ flagged = '!'; waiting = '~'; normal = ' ' }
  foreach ($topic in $State.topics) {
    if ($FilterTopic -and $topic.id -ne $FilterTopic) { continue }
    $rows = @($State.tasks | Where-Object {
        $_.topic -eq $topic.id -and (-not $FilterState -or $_.state -eq $FilterState)
      })
    if (-not $rows) { continue }
    Write-Host ''
    Write-Host $topic.title.ToUpper() -ForegroundColor Cyan
    foreach ($t in $rows) {
      $mark = $glyph[$t.state]
      $colour = switch ($t.state) { 'flagged' { 'Red' } 'waiting' { 'DarkYellow' } default { 'Gray' } }
      $noteMark = if ($t.note) { ' *' } else { '' }
      Write-Host ("  {0} {1,-14} {2}{3}" -f $mark, $t.id, $t.text, $noteMark) -ForegroundColor $colour
    }
  }
  Write-Host ''
}

switch ($Command) {

  'list' {
    $board = Get-Board
    if ($Json) {
      @($board.State.tasks | Where-Object {
          (-not $Topic -or $_.topic -eq $Topic) -and (-not $State -or $_.state -eq $State)
        })
    }
    else {
      Show-Board -State $board.State -FilterTopic $Topic -FilterState $State
    }
  }

  'topics' {
    (Get-Board).State.topics | ForEach-Object { "{0,-18} {1}" -f $_.id, $_.title }
  }

  'add' {
    if (-not $Text) { throw 'add requires -Text.' }
    $topicId = if ($Topic) { $Topic } else { 'inbox' }
    $newState = if ($Flag) { 'flagged' } elseif ($Waiting) { 'waiting' } else { 'normal' }
    $id = New-TaskId
    Update-Board -Message "todo: add $($Text.Substring(0, [Math]::Min(60, $Text.Length)))" -Mutate {
      param($s)
      if ($s.topics.id -notcontains $topicId) { throw "Unknown topic '$topicId'. Run: .\todo.ps1 topics" }
      $task = [pscustomobject]@{
        id      = $id
        text    = $Text.Trim()
        topic   = $topicId
        state   = $newState
        note    = if ($Note) { $Note } else { '' }
        created = (Get-Date).ToUniversalTime().ToString('yyyy-MM-ddTHH:mm:ss.fffZ')
      }
      # New tasks go to the top of their topic, matching the app.
      $idx = 0
      for ($i = 0; $i -lt $s.tasks.Count; $i++) { if ($s.tasks[$i].topic -eq $topicId) { $idx = $i; break } }
      if ($s.tasks.Count -eq 0) { $s.tasks = @($task) }
      else {
        $list = [System.Collections.ArrayList]@($s.tasks)
        $list.Insert([Math]::Min($idx, $list.Count), $task) | Out-Null
        $s.tasks = $list.ToArray()
      }
      $true
    } | Out-Null
    Write-Host "added $id" -ForegroundColor Green
  }

  'done' {
    if (-not $Id) { throw 'done requires -Id.' }
    Update-Board -Message "todo: done $Id" -Mutate {
      param($s)
      $task = Find-Task -State $s -TaskId $Id
      $s.tasks = @($s.tasks | Where-Object { $_.id -ne $Id })
      Write-Host "removed: $($task.text)" -ForegroundColor Green
      $true
    } | Out-Null
  }

  'note' {
    if (-not $Id) { throw 'note requires -Id.' }
    Update-Board -Message "todo: note $Id" -Mutate {
      param($s)
      (Find-Task -State $s -TaskId $Id).note = $Note
      $true
    } | Out-Null
    Write-Host 'note updated' -ForegroundColor Green
  }

  default {
    # flag / wait / normal all set the (mutually exclusive) state.
    if (-not $Id) { throw "$Command requires -Id." }
    $target = @{ flag = 'flagged'; wait = 'waiting'; normal = 'normal' }[$Command]
    Update-Board -Message "todo: mark $Id $target" -Mutate {
      param($s)
      (Find-Task -State $s -TaskId $Id).state = $target
      $true
    } | Out-Null
    Write-Host "$Id -> $target" -ForegroundColor Green
  }
}
