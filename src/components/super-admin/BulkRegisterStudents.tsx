'use client';

import { useState, useCallback } from 'react';
import { useDropzone } from 'react-dropzone';
import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Progress } from '@/components/ui/progress';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { createUserWithEmailAndPassword } from 'firebase/auth';
import { doc } from 'firebase/firestore';
import { useAuth, useFirestore, setDocumentNonBlocking } from '@/firebase';
import type { UserProfile, UserRole } from '@/types';
import { cn } from '@/lib/utils';
import { Upload, FileText, Loader2, X, CheckCircle2, AlertCircle, Download, Clipboard, ClipboardCheck } from 'lucide-react';

interface UserData {
  name: string;
  email: string;
  role: UserRole;
  password?: string;
}

interface RegistrationResult {
  email: string;
  name: string;
  status: 'success' | 'error';
  password?: string;
  error?: string;
}

interface Props {
    onRegistrationComplete: () => void;
}

export function BulkRegisterStudents({ onRegistrationComplete }: Props) {
  const { toast } = useToast();
  const auth = useAuth();
  const firestore = useFirestore();
  const [file, setFile] = useState<File | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);
  const [progress, setProgress] = useState(0);
  const [results, setResults] = useState<RegistrationResult[]>([]);
  const [copiedStates, setCopiedStates] = useState<Record<number, boolean>>({});

  const onDrop = useCallback((acceptedFiles: File[]) => {
    setResults([]);
    if (acceptedFiles.length > 0) {
      setFile(acceptedFiles[0]);
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: {
      'text/csv': ['.csv'],
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'],
      'application/vnd.ms-excel': ['.xls'],
    },
    maxFiles: 1,
  });

  const generateRandomPassword = () => {
    return Math.random().toString(36).slice(-8);
  };

  const copyToClipboard = (text: string, index: number) => {
    navigator.clipboard.writeText(text).then(() => {
        setCopiedStates(prev => ({ ...prev, [index]: true }));
        setTimeout(() => setCopiedStates(prev => ({...prev, [index]: false})), 2000);
    });
  }

  const handleProcessFile = async () => {
    if (!file) {
      toast({ variant: 'destructive', title: 'No file selected.' });
      return;
    }
    setIsProcessing(true);
    setProgress(0);
    setResults([]);

    const reader = new FileReader();
    reader.onload = async (event) => {
      try {
        const fileContent = event.target?.result;
        let userData: UserData[] = [];

        if (file.name.endsWith('.csv')) {
          const result = Papa.parse(fileContent as string, { header: true, skipEmptyLines: true });
          userData = result.data as UserData[];
        } else {
          const workbook = XLSX.read(fileContent, { type: 'binary' });
          const sheetName = workbook.SheetNames[0];
          const worksheet = workbook.Sheets[sheetName];
          userData = XLSX.utils.sheet_to_json<UserData>(worksheet);
        }

        const registrationResults: RegistrationResult[] = [];
        for (let i = 0; i < userData.length; i++) {
          const user = userData[i];
          const password = user.password || generateRandomPassword();

          if (!user.email || !user.name || !user.role) {
            registrationResults.push({ email: user.email || 'N/A', name: user.name || 'N/A', status: 'error', error: 'Missing required fields (name, email, role).' });
            setProgress(((i + 1) / userData.length) * 100);
            continue;
          }

          try {
            const userCredential = await createUserWithEmailAndPassword(auth, user.email, password);
            const newUser = userCredential.user;
            
            const userProfile: UserProfile = { id: newUser.uid, name: user.name, email: user.email, role: user.role };
            const userDocRef = doc(firestore, 'users', newUser.uid);
            await setDocumentNonBlocking(userDocRef, userProfile, {});
            
            registrationResults.push({ email: user.email, name: user.name, status: 'success', password });
          } catch (error: any) {
            registrationResults.push({ email: user.email, name: user.name, status: 'error', error: error.message });
          }
          setProgress(((i + 1) / userData.length) * 100);
        }
        
        setResults(registrationResults);
        toast({ title: 'Processing Complete', description: 'See results below.' });
        onRegistrationComplete();

      } catch (error) {
        toast({ variant: 'destructive', title: 'Error processing file' });
      } finally {
        setIsProcessing(false);
      }
    };
    reader.readAsBinaryString(file);
  };
  
  const downloadResults = () => {
    const successfulRegistrations = results.filter(r => r.status === 'success');
    if(successfulRegistrations.length === 0) {
        toast({variant: 'destructive', title: 'No successful registrations to download.'});
        return;
    }
    const csvContent = Papa.unparse(successfulRegistrations.map(r => ({Email: r.email, Name: r.name, Password: r.password})));
    const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    const link = document.createElement('a');
    link.href = URL.createObjectURL(blob);
    link.setAttribute('download', 'registered_users_passwords.csv');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Bulk Register Students</CardTitle>
        <CardDescription>Upload a CSV or Excel file. Required columns: name, email, role. Optional column: password.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {!file ? (
          <div {...getRootProps()} className={cn(
            "flex flex-col items-center justify-center p-8 border-2 border-dashed rounded-md cursor-pointer hover:border-primary transition-colors",
            isDragActive ? "border-primary bg-primary/10" : "border-input"
          )}>
            <input {...getInputProps()} />
            <Upload className="h-10 w-10 text-muted-foreground mb-2" />
            <p>{isDragActive ? "Drop file here..." : "Drag 'n' drop or click to select a file"}</p>
            <p className="text-xs text-muted-foreground mt-2">CSV, XLSX, or XLS files</p>
          </div>
        ) : (
          <div className="flex items-center justify-between p-3 border rounded-md bg-muted/50">
            <div className="flex items-center gap-3">
              <FileText className="h-6 w-6 text-primary" />
              <div>
                <p className="text-sm font-medium">{file.name}</p>
                <p className="text-xs text-muted-foreground">{(file.size / 1024).toFixed(2)} KB</p>
              </div>
            </div>
            <Button variant="ghost" size="icon" onClick={() => setFile(null)} disabled={isProcessing}>
              <X className="h-4 w-4" />
            </Button>
          </div>
        )}
        <Button onClick={handleProcessFile} disabled={!file || isProcessing} className="w-full">
          {isProcessing ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Upload className="mr-2 h-4 w-4" />}
          {isProcessing ? 'Registering...' : 'Start Registration'}
        </Button>
        {isProcessing && <Progress value={progress} className="w-full" />}
        {results.length > 0 && (
          <div className="space-y-4">
            <div className="flex justify-between items-center">
              <h3 className="text-lg font-semibold">Registration Results</h3>
              <Button onClick={downloadResults} variant="outline" size="sm">
                <Download className="mr-2 h-4 w-4" />
                Download Passwords
              </Button>
            </div>
            <div className="max-h-60 overflow-auto rounded-md border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Status</TableHead>
                    <TableHead>Name</TableHead>
                    <TableHead>Email</TableHead>
                    <TableHead>Details</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {results.map((result, index) => (
                    <TableRow key={index}>
                      <TableCell>
                        {result.status === 'success' ? <CheckCircle2 className="h-5 w-5 text-green-500" /> : <AlertCircle className="h-5 w-5 text-red-500" />}
                      </TableCell>
                      <TableCell>{result.name}</TableCell>
                      <TableCell>{result.email}</TableCell>
                      <TableCell className={cn('font-mono text-xs', result.status === 'error' && 'text-red-500')}>
                         {result.status === 'success' ? (
                            <div className="flex items-center gap-2">
                                <span>Password: <span className="font-bold">{result.password}</span></span>
                                <Button variant="ghost" size="icon" onClick={() => copyToClipboard(result.password!, index)}>
                                    {copiedStates[index] ? <ClipboardCheck className="h-4 w-4 text-green-600" /> : <Clipboard className="h-4 w-4" />}
                                </Button>
                            </div>
                        ) : (
                            result.error
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

    