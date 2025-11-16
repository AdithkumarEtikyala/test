'use client';

import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import * as z from 'zod';
import { useToast } from '@/hooks/use-toast';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from '@/components/ui/form';
import { createUserWithEmailAndPassword } from 'firebase/auth';
import { doc } from 'firebase/firestore';
import { useAuth, useFirestore, setDocumentNonBlocking } from '@/firebase';
import type { UserProfile } from '@/types';
import { Loader2, UserPlus, Clipboard, ClipboardCheck } from 'lucide-react';

const formSchema = z.object({
  name: z.string().min(2, 'Name is required.'),
  email: z.string().email('Invalid email address.'),
  password: z.string().optional(),
});

interface Props {
  onRegistrationComplete: () => void;
}

export function RegisterSingleStudent({ onRegistrationComplete }: Props) {
  const { toast } = useToast();
  const auth = useAuth();
  const firestore = useFirestore();
  const [isLoading, setIsLoading] = useState(false);
  const [generatedPassword, setGeneratedPassword] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: {
      name: '',
      email: '',
      password: '',
    },
  });

  const generateRandomPassword = () => {
    return Math.random().toString(36).slice(-8);
  };
  
  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => {
        setCopied(true);
        setTimeout(() => setCopied(false), 2000);
    });
  }

  const onSubmit = async (values: z.infer<typeof formSchema>) => {
    setIsLoading(true);
    setGeneratedPassword(null);
    const password = values.password || generateRandomPassword();

    try {
      // Create user in Auth
      const userCredential = await createUserWithEmailAndPassword(auth, values.email, password);
      const newUser = userCredential.user;

      // Create user profile in Firestore
      const userProfile: UserProfile = {
        id: newUser.uid,
        name: values.name,
        email: values.email,
        role: 'student',
      };
      const userDocRef = doc(firestore, 'users', newUser.uid);
      await setDocumentNonBlocking(userDocRef, userProfile, {});

      setGeneratedPassword(password);
      onRegistrationComplete();
      form.reset();
      toast({
        title: 'Student Registered Successfully',
        description: `${values.name} has been added.`,
      });
    } catch (error: any) {
      toast({
        variant: 'destructive',
        title: 'Registration Failed',
        description: error.message,
      });
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>Register a Single Student</CardTitle>
        <CardDescription>
          Enter the student's details. You can set a password or leave it blank to generate a random one.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Form {...form}>
          <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
            <FormField
              control={form.control}
              name="name"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Full Name</FormLabel>
                  <FormControl>
                    <Input placeholder="John Doe" {...field} disabled={isLoading} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="email"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Email</FormLabel>
                  <FormControl>
                    <Input placeholder="student@example.com" {...field} disabled={isLoading} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <FormField
              control={form.control}
              name="password"
              render={({ field }) => (
                <FormItem>
                  <FormLabel>Password</FormLabel>
                  <FormControl>
                    <Input type="password" placeholder="Leave blank to generate random" {...field} disabled={isLoading} />
                  </FormControl>
                  <FormMessage />
                </FormItem>
              )}
            />
            <Button type="submit" disabled={isLoading} className="w-full">
              {isLoading ? (
                <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              ) : (
                <UserPlus className="mr-2 h-4 w-4" />
              )}
              {isLoading ? 'Registering...' : 'Register Student'}
            </Button>
          </form>
        </Form>
        {generatedPassword && (
          <div className="mt-6 rounded-md border bg-muted/50 p-4">
            <p className="text-sm font-medium">Student registered! Please provide them with their credentials:</p>
            <div className="mt-2 flex items-center gap-2 rounded-md border bg-background p-2">
                <span className="flex-1 font-mono text-sm">
                    Password: <span className="font-bold">{generatedPassword}</span>
                </span>
                <Button variant="ghost" size="icon" onClick={() => copyToClipboard(generatedPassword)}>
                    {copied ? <ClipboardCheck className="h-4 w-4 text-green-600" /> : <Clipboard className="h-4 w-4" />}
                </Button>
            </div>
            <p className="mt-2 text-xs text-muted-foreground">This password will only be shown once.</p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
