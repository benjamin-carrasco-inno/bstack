#Requires -Version 7
<#
.SYNOPSIS
  Counts things.
#>
param([string]$Name)

# Say hello.
Write-Output "Hello $Name # not a comment"
Write-Output 'single # not a comment'
Write-Output "escaped `" quote # still a string"
$x = 1 # trailing
