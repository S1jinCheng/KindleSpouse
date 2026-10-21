using System;
using System.Runtime.InteropServices;
using System.Threading;

public static class KindleNativeCopy
{
    [ComImport, Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IShellItem {}

    [ComImport, Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    private interface IFileOperation
    {
        void Advise(IntPtr sink, out uint cookie);
        void Unadvise(uint cookie);
        void SetOperationFlags(uint flags);
        void SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
        void SetProgressDialog(IntPtr dialog);
        void SetProperties(IntPtr changes);
        void SetOwnerWindow(IntPtr window);
        void ApplyPropertiesToItem(IShellItem item);
        void ApplyPropertiesToItems([MarshalAs(UnmanagedType.IUnknown)] object items);
        void RenameItem(IShellItem item, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
        void RenameItems([MarshalAs(UnmanagedType.IUnknown)] object items, [MarshalAs(UnmanagedType.LPWStr)] string name);
        void MoveItem(IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
        void MoveItems([MarshalAs(UnmanagedType.IUnknown)] object items, IShellItem destination);
        void CopyItem(IShellItem item, IShellItem destination, [MarshalAs(UnmanagedType.LPWStr)] string name, IntPtr sink);
        void CopyItems([MarshalAs(UnmanagedType.IUnknown)] object items, IShellItem destination);
        void DeleteItem(IShellItem item, IntPtr sink);
        void DeleteItems([MarshalAs(UnmanagedType.IUnknown)] object items);
        void NewItem(IShellItem destination, uint attributes, [MarshalAs(UnmanagedType.LPWStr)] string name, [MarshalAs(UnmanagedType.LPWStr)] string template, IntPtr sink);
        void PerformOperations();
        void GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
    }

    [DllImport("shell32.dll", PreserveSig = true)]
    private static extern int SHGetIDListFromObject([MarshalAs(UnmanagedType.IUnknown)] object item, out IntPtr list);

    [DllImport("shell32.dll", PreserveSig = true)]
    private static extern int SHCreateItemFromIDList(IntPtr list, ref Guid id, out IShellItem item);

    private static IShellItem CreateItem(IntPtr list)
    {
        Guid id = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
        IShellItem item;
        Marshal.ThrowExceptionForHR(SHCreateItemFromIDList(list, ref id, out item));
        return item;
    }

    public static void CopyNamed(object source, object destination, string name)
    {
        IntPtr sourceList = IntPtr.Zero;
        IntPtr destinationList = IntPtr.Zero;
        try
        {
            Marshal.ThrowExceptionForHR(SHGetIDListFromObject(source, out sourceList));
            Marshal.ThrowExceptionForHR(SHGetIDListFromObject(destination, out destinationList));
            Exception failure = null;
            Thread worker = new Thread(() =>
            {
                IShellItem sourceItem = null;
                IShellItem destinationItem = null;
                IFileOperation operation = null;
                try
                {
                    sourceItem = CreateItem(sourceList);
                    destinationItem = CreateItem(destinationList);
                    operation = (IFileOperation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3AD05575-8857-4850-9277-11B85BDB8E09")));
                    operation.SetOperationFlags(1556);
                    operation.CopyItem(sourceItem, destinationItem, name, IntPtr.Zero);
                    operation.PerformOperations();
                    bool aborted;
                    operation.GetAnyOperationsAborted(out aborted);
                    if (aborted) throw new InvalidOperationException("The transfer was cancelled.");
                }
                catch (Exception error) { failure = error; }
                finally
                {
                    if (operation != null) Marshal.ReleaseComObject(operation);
                    if (destinationItem != null) Marshal.ReleaseComObject(destinationItem);
                    if (sourceItem != null) Marshal.ReleaseComObject(sourceItem);
                }
            });
            worker.SetApartmentState(ApartmentState.STA);
            worker.Start();
            worker.Join();
            if (failure != null) throw new InvalidOperationException("Native file transfer failed.", failure);
        }
        finally
        {
            if (sourceList != IntPtr.Zero) Marshal.FreeCoTaskMem(sourceList);
            if (destinationList != IntPtr.Zero) Marshal.FreeCoTaskMem(destinationList);
        }
    }
}
