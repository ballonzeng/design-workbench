$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = New-Object Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$originalStream = $null
$ownerStream = $null
$result = @{ locked = $true; recovered = $false; reason = 'probe-failed' }
$nativeSource = @'
using System;
using System.IO;
using System.Text;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
namespace Workbench {
 public static class ExcelLockNative {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern SafeFileHandle CreateFile(string name, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  static extern bool SetFileInformationByHandle(SafeFileHandle file, int kind, IntPtr info, uint size);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  struct RenameInfo { public byte Replace; public IntPtr Root; public uint Length; public char Name; }
  public static FileStream OpenOwner(string name) {
   SafeFileHandle handle=CreateFile(name,0xC0010000,0,IntPtr.Zero,3,0x80,IntPtr.Zero);
   if(handle.IsInvalid) { int error=Marshal.GetLastWin32Error(); handle.Dispose(); throw new Win32Exception(error); }
   try { return new FileStream(handle,FileAccess.ReadWrite,4096,false); } catch { handle.Dispose(); throw; }
  }
  public static void RenameOwner(FileStream stream,string destination) {
   byte[] name=Encoding.Unicode.GetBytes(Path.GetFullPath(destination));
   // Absolute-path conversion also reads a UTF-16 terminator; Length excludes it.
   int offset=Marshal.OffsetOf(typeof(RenameInfo),"Name").ToInt32(),size=checked(offset+name.Length+2);
   IntPtr buffer=Marshal.AllocHGlobal(size);
   try {
    Marshal.Copy(new byte[size],0,buffer,size);
    Marshal.WriteInt32(buffer,Marshal.OffsetOf(typeof(RenameInfo),"Length").ToInt32(),name.Length);
    Marshal.Copy(name,0,IntPtr.Add(buffer,offset),name.Length);
    if(!SetFileInformationByHandle(stream.SafeFileHandle,3,buffer,(uint)size))throw new Win32Exception(Marshal.GetLastWin32Error());
   } finally { Marshal.FreeHGlobal(buffer); }
  }
 }
}
'@

function Get-NormalizedPath([string] $Value) {
    if ([string]::IsNullOrWhiteSpace($Value) -or -not [IO.Path]::IsPathRooted($Value)) {
        throw 'An absolute path is required.'
    }
    return [IO.Path]::GetFullPath($Value)
}

function Assert-InRoot([string] $Value, [string] $Root) {
    $prefix = $Root.TrimEnd([char[]] '\/') + [IO.Path]::DirectorySeparatorChar
    if (-not $Value.Equals($Root, [StringComparison]::OrdinalIgnoreCase) -and
        -not $Value.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The path is outside the configured root.'
    }
}

function Assert-NoLinks([string] $Value, [string] $Root) {
    Assert-InRoot $Value $Root
    $walk = $Value
    while ($true) {
        $entry = Get-Item -LiteralPath $walk -Force -ErrorAction Stop
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Linked paths are not supported.'
        }
        if ($walk.Equals($Root, [StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = [IO.Path]::GetDirectoryName($walk.TrimEnd([char[]] '\/'))
        if ([string]::IsNullOrWhiteSpace($parent) -or $parent -eq $walk) {
            throw 'The configured root could not be verified.'
        }
        $walk = $parent
    }
    # Also reject a linked ancestor of a local configured root.
    $volumeRoot = [IO.Path]::GetPathRoot($Root).TrimEnd([char[]] '\/')
    if ($Root.TrimEnd([char[]] '\/').Equals($volumeRoot, [StringComparison]::OrdinalIgnoreCase)) { return }
    $walk = [IO.Path]::GetDirectoryName($Root.TrimEnd([char[]] '\/'))
    while (-not [string]::IsNullOrWhiteSpace($walk)) {
        $entry = Get-Item -LiteralPath $walk -Force -ErrorAction Stop
        if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw 'Linked root paths are not supported.'
        }
        if ($walk.TrimEnd([char[]] '\/').Equals($volumeRoot, [StringComparison]::OrdinalIgnoreCase)) { break }
        $parent = [IO.Path]::GetDirectoryName($walk.TrimEnd([char[]] '\/'))
        if ($parent -eq $walk) { break }
        $walk = $parent
    }
}

function Get-StreamHash([IO.Stream] $Stream) {
    $hasher = [Security.Cryptography.SHA256]::Create()
    try {
        $Stream.Position = 0
        return ([BitConverter]::ToString($hasher.ComputeHash($Stream))).Replace('-', '').ToLowerInvariant()
    } finally {
        $Stream.Position = 0
        $hasher.Dispose()
    }
}

function Test-CooledDown($Entry) {
    return ([DateTime]::UtcNow - $Entry.LastWriteTimeUtc).TotalSeconds -ge 120
}

try {
    $root = (Get-NormalizedPath $env:DW_EXCEL_ROOT).TrimEnd([char[]] '\/')
    # Keep drive roots valid after removing the trailing separator.
    if ($root -match '^[A-Za-z]:$') { $root += '\' }
    $file = Get-NormalizedPath $env:DW_EXCEL_FILE
    Assert-InRoot $file $root
    Assert-NoLinks $file $root
    if (-not [IO.File]::Exists($file)) { throw 'The workbook was not found.' }
    $owner = [IO.Path]::Combine([IO.Path]::GetDirectoryName($file), '~$' + [IO.Path]::GetFileName($file))
    Assert-InRoot $owner $root
    if (-not [IO.File]::Exists($owner)) {
        # File.Exists hides access failures, so verify the parent before accepting absence.
        $null = Get-Item -LiteralPath ([IO.Path]::GetDirectoryName($owner)) -Force -ErrorAction Stop
        try {
            $null = Get-Item -LiteralPath $owner -Force -ErrorAction Stop
            throw 'The owner file could not be accessed.'
        } catch [System.Management.Automation.ItemNotFoundException] {
            $result = @{ locked = $false; recovered = $false; reason = 'no-owner-file' }
        }
    } else {
        Assert-NoLinks $owner $root
        $beforeFile = Get-Item -LiteralPath $file -Force
        $beforeOwner = Get-Item -LiteralPath $owner -Force
        if (-not (Test-CooledDown $beforeFile) -or -not (Test-CooledDown $beforeOwner)) {
            $result.reason = 'recent'
        } else {
            if (-not ('Workbench.ExcelLockNative' -as [type])) { Add-Type -TypeDefinition $nativeSource -ErrorAction Stop | Out-Null }
            # Share.None protects the workbook while the stale owner is isolated.
            # Large sequential reads avoid one SMB round trip per default 4 KiB buffer.
            # This six-argument constructor is available in Windows PowerShell 5.1 / .NET Framework.
            $originalStream = New-Object IO.FileStream($file, [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::None, 1048576, [IO.FileOptions]::SequentialScan)
            # DELETE access permits renaming this exact held file; share=0 denies replacement races.
            $ownerStream = [Workbench.ExcelLockNative]::OpenOwner($owner)
            $heldFile = Get-Item -LiteralPath $file -Force
            $heldOwner = Get-Item -LiteralPath $owner -Force
            if ($heldFile.Length -ne $beforeFile.Length -or $heldFile.LastWriteTimeUtc -ne $beforeFile.LastWriteTimeUtc -or
                $heldOwner.Length -ne $beforeOwner.Length -or $heldOwner.LastWriteTimeUtc -ne $beforeOwner.LastWriteTimeUtc -or
                -not (Test-CooledDown $heldFile) -or -not (Test-CooledDown $heldOwner)) {
                $result.reason = 'changed'
                throw 'The workbook or owner changed during the probe.'
            }
            $originalHash = Get-StreamHash $originalStream
            $ownerHash = Get-StreamHash $ownerStream
            $recoveryRoot = [IO.Path]::Combine($root, '_workbench-system', 'recovery', 'excel-locks')
            # Validate each existing ancestor before creating a recovery subdirectory.
            $walk = $recoveryRoot
            while (-not [IO.Directory]::Exists($walk)) {
                if ([IO.File]::Exists($walk)) { throw 'The recovery directory is not a directory.' }
                $walk = [IO.Path]::GetDirectoryName($walk)
            }
            Assert-NoLinks $walk $root
            $null = [IO.Directory]::CreateDirectory($recoveryRoot)
            Assert-NoLinks $recoveryRoot $root
            $stamp = [DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')
            $recovery = [IO.Path]::Combine($recoveryRoot, $stamp + '-' + [Guid]::NewGuid().ToString('N'))
            $null = [IO.Directory]::CreateDirectory($recovery)
            Assert-NoLinks $recovery $root
            $destination = [IO.Path]::Combine($recovery, [IO.Path]::GetFileName($owner))
            $manifestPath = [IO.Path]::Combine($recovery, 'manifest.json')
            $manifest = [ordered]@{
                version = 1
                status = 'prepared'
                reason = 'Workbook and owner allowed simultaneous exclusive read/write probes after the 120-second cooldown.'
                at = [DateTime]::UtcNow.ToString('o')
                source = $owner
                workbook = $file
                recoveryPath = $destination
                size = $ownerStream.Length
                sha256 = $ownerHash
                workbookSize = $originalStream.Length
                workbookSha256 = $originalHash
                sourceLastWriteTimeUtc = $heldOwner.LastWriteTimeUtc.ToString('o')
            }
            $utf8 = New-Object Text.UTF8Encoding($false)
            [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), $utf8)
            # Same-volume rename, no overwrite; both handles remain held until verification completes.
            [Workbench.ExcelLockNative]::RenameOwner($ownerStream, $destination)
            if ((Get-StreamHash $ownerStream) -ne $ownerHash -or (Get-StreamHash $originalStream) -ne $originalHash) {
                throw 'The held file changed during owner recovery.'
            }
            $manifest.status = 'recovered'
            [IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json -Depth 4), $utf8)
            $result = @{ locked = $false; recovered = $true; recoveryPath = $destination; reason = 'stale-owner-recovered' }
        }
    }
} catch {
    $failure = $_.Exception
    while ($null -ne $failure.InnerException) { $failure = $failure.InnerException }
    $nativeCode = if ($failure -is [ComponentModel.Win32Exception]) { $failure.NativeErrorCode } else { $failure.HResult -band 65535 }
    $failureReason = if ($nativeCode -eq 32 -or $nativeCode -eq 33) { 'busy' } elseif ($result.reason -eq 'changed') { 'changed' } else { 'probe-failed' }
    $result = @{ locked = $true; recovered = $false; reason = $failureReason; error = $failure.Message }
} finally {
    if ($null -ne $ownerStream) { $ownerStream.Dispose() }
    if ($null -ne $originalStream) { $originalStream.Dispose() }
}
$result | ConvertTo-Json -Compress -Depth 4
