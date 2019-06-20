import { async, ComponentFixture, TestBed } from '@angular/core/testing';
import { NewsOnlineResultsTableComponent } from './online-results-table.component';

describe('NewsOnlineResultsTableComponent', () => {
    let component: NewsOnlineResultsTableComponent;
    let fixture: ComponentFixture<NewsOnlineResultsTableComponent>;

    beforeEach(async(() => {
        TestBed.configureTestingModule({
            declarations: [NewsOnlineResultsTableComponent],
        }).compileComponents();
    }));

    beforeEach(() => {
        fixture = TestBed.createComponent(NewsOnlineResultsTableComponent);
        component = fixture.componentInstance;
        fixture.detectChanges();
    });

    it('should create', () => {
        expect(component).toBeTruthy();
    });
});
