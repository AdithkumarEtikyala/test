
'use client';
import { CreateExam } from '@/components/faculty/CreateExam';
import { ExamList } from '@/components/faculty/ExamList';
import { ContactSupportCard } from '@/components/shared/ContactSupportCard';

export default function FacultyDashboard() {

  return (
    <div className="container py-8">
      <div className="flex flex-wrap items-center justify-between gap-4 mb-8">
        <h1 className="text-3xl font-bold tracking-tight">My Exams</h1>
        <CreateExam />
      </div>
      <div className="grid gap-8 lg:grid-cols-3">
        <div className="lg:col-span-2 space-y-8">
            <ExamList />
        </div>
        <div className="lg:col-span-1">
            <ContactSupportCard />
        </div>
      </div>
    </div>
  );
}
